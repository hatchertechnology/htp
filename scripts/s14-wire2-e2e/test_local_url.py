#!/usr/bin/env python3
"""Regression checks for the credential-bearing local HTTP endpoints."""
import unittest
from unittest.mock import patch

from local_url import check


class LocalUrlTests(unittest.TestCase):
    def test_literal_loopback_and_localhost(self):
        for endpoint in ('http://127.0.0.1:8967', 'http://[::1]:8967', 'http://localhost:8967'):
            with self.subTest(endpoint=endpoint):
                check(endpoint)

    def test_nonlocal_or_ambiguous_endpoints_are_rejected(self):
        for endpoint in ('http://127.0.0.1:1@203.0.113.9/',
                         'http://127.0.0.1@localhost:80/', 'https://localhost:80/',
                         'http://127.0.0.2:80/', 'http://localhost:80/?next=x',
                         'http://localhost:80\\@example.com/'):
            with self.subTest(endpoint=endpoint), self.assertRaises(SystemExit):
                check(endpoint)

    def test_localhost_must_resolve_only_to_loopback(self):
        remote = [(2, 1, 6, '', ('203.0.113.9', 80))]
        with patch('local_url.socket.getaddrinfo', return_value=remote), self.assertRaises(SystemExit):
            check('http://localhost:80')


if __name__ == '__main__':
    unittest.main()
