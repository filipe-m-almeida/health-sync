import ouraProvider from './oura.js';
import withingsProvider from './withings.js';
import hevyProvider from './hevy.js';
import stravaProvider from './strava.js';
import eightsleepProvider from './eightsleep.js';
import whoopProvider from './whoop.js';

export function builtInProviders() {
  return [
    ouraProvider,
    withingsProvider,
    hevyProvider,
    stravaProvider,
    eightsleepProvider,
    whoopProvider,
  ];
}
