import time
import unittest
from unittest.mock import patch
import sys
import types

try:
    from fastapi import HTTPException
except ModuleNotFoundError:
    fastapi_stub = types.ModuleType("fastapi")
    class HTTPException(Exception):
        def __init__(self, status_code, detail):
            self.status_code = status_code
            self.detail = detail
    fastapi_stub.HTTPException = HTTPException
    fastapi_stub.Request = object
    sys.modules["fastapi"] = fastapi_stub

import media_policy


class FakeRequest:
    def __init__(self, token=""):
        self.headers = {"x-admin-mode-token": token} if token else {}


class MediaPolicyTests(unittest.TestCase):
    def test_duration_parser(self):
        self.assertEqual(media_policy.parse_duration("10:00"), 600)
        self.assertEqual(media_policy.parse_duration("1:02:03"), 3723)
        self.assertIsNone(media_policy.parse_duration("unknown"))

    def test_ten_minutes_is_allowed(self):
        media_policy.enforce_duration(600, FakeRequest())

    def test_over_ten_minutes_is_rejected(self):
        with self.assertRaises(HTTPException) as caught:
            media_policy.enforce_duration(600.001, FakeRequest())
        self.assertEqual(caught.exception.status_code, 413)

    def test_wrong_password_is_rejected(self):
        with self.assertRaises(HTTPException) as caught:
            media_policy.authenticate("wrong")
        self.assertEqual(caught.exception.status_code, 401)

    def test_valid_admin_token_bypasses_limit(self):
        token = media_policy.authenticate("go for it")
        request = FakeRequest(token)
        self.assertTrue(media_policy.is_admin_request(request))
        media_policy.enforce_duration(3600, request)

    def test_expired_admin_token_is_rejected(self):
        with patch.object(time, "time", return_value=100):
            token = media_policy.authenticate("go for it")
        with patch.object(time, "time", return_value=100 + media_policy.ADMIN_MODE_TTL_SECONDS + 1):
            self.assertFalse(media_policy.is_admin_request(FakeRequest(token)))


if __name__ == "__main__":
    unittest.main()
