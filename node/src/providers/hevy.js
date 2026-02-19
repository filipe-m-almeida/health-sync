import {
  dtToIsoZ,
  requestJson,
  sha256Hex,
  toEpochSeconds,
} from '../util.js';

function clampPageSize(rawValue) {
  const parsed = Number.parseInt(String(rawValue ?? 10), 10);
  if (!Number.isFinite(parsed)) {
    return 10;
  }
  return Math.max(1, Math.min(10, parsed));
}

function isoFromEpochSeconds(epochSeconds) {
  const value = Number(epochSeconds);
  if (!Number.isFinite(value)) {
    return null;
  }
  return dtToIsoZ(new Date(Math.floor(value) * 1000));
}

function hevyHeaders(apiKey) {
  return {
    'api-key': apiKey,
  };
}

function workoutRecordShape(workout) {
  return {
    recordId: workout?.id ? String(workout.id) : sha256Hex(JSON.stringify(workout)),
    startTime: workout?.start_time || null,
    endTime: workout?.end_time || null,
    sourceUpdatedAt: workout?.updated_at || workout?.created_at || null,
  };
}

function eventTimestamp(event) {
  return event?.updated_at || event?.deleted_at || event?.timestamp || event?.created_at || null;
}

async function hevyInitialSync(db, cfg, apiKey) {
  await db.syncRun('hevy', 'workouts', async () => {
    await db.transaction(async () => {
      const baseUrl = String(cfg.base_url || 'https://api.hevyapp.com').replace(/\/$/, '');
      const pageSize = clampPageSize(cfg.page_size);

      let page = 1;
      let maxUpdatedEpoch = null;

      while (true) {
        const response = await requestJson(`${baseUrl}/v1/workouts`, {
          headers: hevyHeaders(apiKey),
          params: {
            page,
            pageSize,
          },
        });

        const workouts = Array.isArray(response?.workouts)
          ? response.workouts
          : Array.isArray(response?.data)
            ? response.data
            : [];

        for (const workout of workouts) {
          const shape = workoutRecordShape(workout);
          db.upsertRecord({
            provider: 'hevy',
            resource: 'workouts',
            recordId: shape.recordId,
            startTime: shape.startTime,
            endTime: shape.endTime,
            sourceUpdatedAt: shape.sourceUpdatedAt,
            payload: workout,
          });

          const updatedEpoch = toEpochSeconds(shape.sourceUpdatedAt);
          if (updatedEpoch !== null) {
            maxUpdatedEpoch = maxUpdatedEpoch === null
              ? updatedEpoch
              : Math.max(maxUpdatedEpoch, updatedEpoch);
          }
        }

        const pageCount = Number.parseInt(String(response?.page_count ?? response?.pageCount ?? 0), 10) || 0;
        if (!workouts.length || pageCount <= 0 || page >= pageCount) {
          break;
        }
        page += 1;
      }

      const watermarkEpoch = maxUpdatedEpoch ?? Math.floor(Date.now() / 1000);
      db.setSyncState('hevy', 'workouts', {
        watermark: isoFromEpochSeconds(watermarkEpoch),
      });
    });
  });
}

async function hevyDeltaSync(db, cfg, apiKey) {
  const baseUrl = String(cfg.base_url || 'https://api.hevyapp.com').replace(/\/$/, '');
  const pageSize = clampPageSize(cfg.page_size);
  const parsedOverlap = Number.parseInt(String(cfg.overlap_seconds ?? 300), 10);
  const overlapSeconds = Number.isFinite(parsedOverlap) ? Math.max(0, parsedOverlap) : 300;

  const state = db.getSyncState('hevy', 'workouts');
  const watermarkEpoch = toEpochSeconds(state?.watermark);
  const fallbackSinceEpoch = toEpochSeconds(cfg.since || '1970-01-01T00:00:00Z') || 0;
  const sinceEpoch = watermarkEpoch === null
    ? fallbackSinceEpoch
    : Math.max(fallbackSinceEpoch, Math.max(0, watermarkEpoch - overlapSeconds));

  await db.syncRun('hevy', 'workouts', async () => {
    await db.syncRun('hevy', 'workout_events', async () => {
      await db.transaction(async () => {
        let page = 1;
        let maxEventEpoch = watermarkEpoch;

        while (true) {
          const response = await requestJson(`${baseUrl}/v1/workouts/events`, {
            headers: hevyHeaders(apiKey),
            params: {
              page,
              pageSize,
              since: isoFromEpochSeconds(sinceEpoch),
            },
          });

          const events = Array.isArray(response?.events)
            ? response.events
            : Array.isArray(response?.data)
              ? response.data
              : [];

          for (const event of events) {
            const type = String(event?.type || '').toLowerCase();
            const eventTs = eventTimestamp(event);
            const eventEpoch = toEpochSeconds(eventTs);
            if (eventEpoch !== null) {
              maxEventEpoch = maxEventEpoch === null
                ? eventEpoch
                : Math.max(maxEventEpoch, eventEpoch);
            }

            if (type === 'updated') {
              const workout = event?.workout && typeof event.workout === 'object'
                ? event.workout
                : event?.data && typeof event.data === 'object'
                  ? event.data
                  : null;

              const workoutId = workout?.id || event?.workout_id || event?.id;
              if (workout && workoutId) {
                const shape = workoutRecordShape(workout);
                db.upsertRecord({
                  provider: 'hevy',
                  resource: 'workouts',
                  recordId: String(workoutId),
                  startTime: shape.startTime,
                  endTime: shape.endTime,
                  sourceUpdatedAt: shape.sourceUpdatedAt,
                  payload: workout,
                }, { provider: 'hevy', resource: 'workouts' });
              }

              const auditId = `updated:${workoutId || 'unknown'}:${eventTs || 'na'}`;
              db.upsertRecord({
                provider: 'hevy',
                resource: 'workout_events',
                recordId: auditId,
                startTime: eventTs,
                endTime: null,
                sourceUpdatedAt: eventTs,
                payload: event,
              }, { provider: 'hevy', resource: 'workout_events' });
              continue;
            }

            if (type === 'deleted') {
              const workoutId = event?.workout_id || event?.id || null;
              if (workoutId) {
                db.deleteRecord('hevy', 'workouts', String(workoutId), { provider: 'hevy', resource: 'workouts' });
              }

              const deletedTs = event?.deleted_at || eventTs;
              const auditId = `deleted:${workoutId || 'unknown'}:${deletedTs || 'na'}`;
              db.upsertRecord({
                provider: 'hevy',
                resource: 'workout_events',
                recordId: auditId,
                startTime: deletedTs,
                endTime: null,
                sourceUpdatedAt: deletedTs,
                payload: event,
              }, { provider: 'hevy', resource: 'workout_events' });
              continue;
            }

            const unknownId = `unknown:${sha256Hex(JSON.stringify(event))}`;
            db.upsertRecord({
              provider: 'hevy',
              resource: 'workout_events',
              recordId: unknownId,
              startTime: eventTs,
              endTime: null,
              sourceUpdatedAt: eventTs,
              payload: event,
            }, { provider: 'hevy', resource: 'workout_events' });
          }

          const pageCount = Number.parseInt(String(response?.page_count ?? response?.pageCount ?? 0), 10) || 0;
          if (!events.length || pageCount <= 0 || page >= pageCount) {
            break;
          }
          page += 1;
        }

        if (maxEventEpoch !== null) {
          db.setSyncState('hevy', 'workouts', {
            watermark: isoFromEpochSeconds(maxEventEpoch),
          });
        }
      });
    });
  });
}

async function hevySync(db, config, helpers) {
  const cfg = helpers.configFor('hevy');
  const apiKey = helpers.requireStr('hevy', 'api_key', 'Missing [hevy].api_key');

  const state = db.getSyncState('hevy', 'workouts');
  if (!state?.watermark) {
    await hevyInitialSync(db, cfg, apiKey);
    return;
  }

  await hevyDeltaSync(db, cfg, apiKey);
}

const hevyProvider = {
  id: 'hevy',
  source: 'builtin',
  description: 'Hevy workouts and workout event deltas',
  supportsAuth: false,
  sync: hevySync,
};

export default hevyProvider;
