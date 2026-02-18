from __future__ import annotations

import unittest
import warnings
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from unittest.mock import Mock, call, patch

import requests

from health_sync.util import _oauth_result_from_paste, _parse_retry_after_seconds, request_json, to_epoch_seconds


class _FakeResponse:
    def __init__(
        self,
        status_code: int,
        *,
        headers: dict[str, str] | None = None,
        text: str = "",
        json_body=None,  # noqa: ANN001
        json_error: Exception | None = None,
    ) -> None:
        self.status_code = status_code
        self.headers = headers or {}
        self.text = text
        self._json_body = {} if json_body is None else json_body
        self._json_error = json_error

    def json(self):  # noqa: ANN201
        if self._json_error is not None:
            raise self._json_error
        return self._json_body


class RetryAfterParsingTests(unittest.TestCase):
    def test_retry_after_seconds_numeric(self) -> None:
        self.assertEqual(_parse_retry_after_seconds("5"), 5)

    def test_retry_after_http_date(self) -> None:
        future = datetime.now(UTC) + timedelta(seconds=20)
        header = format_datetime(future, usegmt=True)
        parsed = _parse_retry_after_seconds(header)
        self.assertIsNotNone(parsed)
        self.assertGreaterEqual(parsed or 0, 1)
        self.assertLessEqual(parsed or 0, 25)

    def test_retry_after_invalid_warns(self) -> None:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            parsed = _parse_retry_after_seconds("nonsense")
        self.assertIsNone(parsed)
        self.assertTrue(any("Could not parse Retry-After header value" in str(w.message) for w in caught))


class EpochParsingTests(unittest.TestCase):
    def test_epoch_parsing_accepts_epoch_string(self) -> None:
        self.assertEqual(to_epoch_seconds("1770715852"), 1770715852)

    def test_epoch_parsing_accepts_iso(self) -> None:
        self.assertEqual(to_epoch_seconds("2026-02-10T09:30:52Z"), 1770715852)

    def test_epoch_parsing_accepts_date(self) -> None:
        self.assertEqual(to_epoch_seconds("2026-02-10"), 1770681600)


class OAuthPasteParsingTests(unittest.TestCase):
    def test_parses_full_callback_url(self) -> None:
        parsed = _oauth_result_from_paste("http://127.0.0.1:8486/callback?code=abc123&state=s1")
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed.code, "abc123")
        self.assertEqual(parsed.state, "s1")
        self.assertIsNone(parsed.error)

    def test_parses_query_string_shape(self) -> None:
        parsed = _oauth_result_from_paste("?code=xyz789&state=s2")
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed.code, "xyz789")
        self.assertEqual(parsed.state, "s2")

    def test_parses_raw_code_fallback(self) -> None:
        parsed = _oauth_result_from_paste("plain-code-token")
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed.code, "plain-code-token")
        self.assertIsNone(parsed.state)

    def test_rejects_unstructured_text(self) -> None:
        self.assertIsNone(_oauth_result_from_paste("this is not oauth input"))


class RequestJsonTests(unittest.TestCase):
    def test_retries_429_with_retry_after_header(self) -> None:
        sess = Mock(spec=requests.Session)
        sess.request.side_effect = [
            _FakeResponse(429, headers={"Retry-After": "3"}),
            _FakeResponse(200, json_body={"ok": True}),
        ]

        with patch("health_sync.util.time.sleep") as sleep:
            out = request_json(sess, "GET", "https://example.test/endpoint")

        self.assertEqual(out, {"ok": True})
        self.assertEqual(sess.request.call_count, 2)
        sleep.assert_called_once_with(3)

    def test_retries_5xx_with_exponential_backoff(self) -> None:
        sess = Mock(spec=requests.Session)
        sess.request.side_effect = [
            _FakeResponse(500),
            _FakeResponse(502),
            _FakeResponse(200, json_body={"ok": True}),
        ]

        with patch("health_sync.util.time.sleep") as sleep:
            out = request_json(sess, "GET", "https://example.test/endpoint")

        self.assertEqual(out, {"ok": True})
        self.assertEqual(sess.request.call_count, 3)
        sleep.assert_has_calls([call(1), call(2)])

    def test_4xx_includes_trace_id_and_error_details(self) -> None:
        sess = Mock(spec=requests.Session)
        sess.request.return_value = _FakeResponse(
            403,
            headers={"x-trace-id": "trace-1"},
            json_body={"error": "invalid_scope", "error_description": "revoked"},
        )

        with patch("health_sync.util.time.sleep") as sleep:
            with self.assertRaisesRegex(
                RuntimeError,
                r"HTTP 403 .*trace_id=trace-1.*error=invalid_scope.*error_description=revoked",
            ):
                request_json(sess, "GET", "https://example.test/endpoint")

        self.assertEqual(sess.request.call_count, 1)
        sleep.assert_not_called()

    def test_4xx_falls_back_to_response_text_when_json_is_invalid(self) -> None:
        sess = Mock(spec=requests.Session)
        sess.request.return_value = _FakeResponse(
            400,
            text="bad request body",
            json_error=ValueError("invalid-json"),
        )

        with self.assertRaisesRegex(RuntimeError, r"HTTP 400 .*bad request body"):
            request_json(sess, "GET", "https://example.test/endpoint")

        self.assertEqual(sess.request.call_count, 1)

    def test_raises_after_max_retries_on_network_errors(self) -> None:
        sess = Mock(spec=requests.Session)
        sess.request.side_effect = [requests.ConnectionError("net down")] * 3

        with patch("health_sync.util.time.sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, r"HTTP request failed after 3 attempts") as ctx:
                request_json(sess, "GET", "https://example.test/endpoint", max_retries=3)

        self.assertIsInstance(ctx.exception.__cause__, requests.ConnectionError)
        self.assertEqual(sess.request.call_count, 3)
        sleep.assert_has_calls([call(1), call(2), call(4)])

    def test_raises_when_success_response_is_not_json(self) -> None:
        sess = Mock(spec=requests.Session)
        sess.request.return_value = _FakeResponse(200, json_error=ValueError("invalid-json"))

        with self.assertRaisesRegex(RuntimeError, r"Failed to parse JSON response for GET https://example.test/endpoint"):
            request_json(sess, "GET", "https://example.test/endpoint")

        self.assertEqual(sess.request.call_count, 1)


if __name__ == "__main__":
    unittest.main()
