#!/usr/bin/env python3
"""Reject URLs that can send harness credentials away from loopback."""
import sys
import ipaddress
import socket
from urllib.parse import urlsplit

def check(value):
    try:
        if any(ord(c) <= 32 or ord(c) == 127 or c == '\\' for c in value):
            raise ValueError()
        u = urlsplit(value)
        if (u.scheme != 'http' or u.hostname not in ('127.0.0.1', '::1', 'localhost')
                or u.username is not None or u.password is not None or u.port is None
                or u.query or u.fragment):
            raise ValueError()
        if any(not ipaddress.ip_address(a[4][0]).is_loopback for a in socket.getaddrinfo(u.hostname, u.port, type=socket.SOCK_STREAM)):
            raise ValueError()
        return u
    except ValueError:
        raise SystemExit('endpoint must be loopback HTTP with an explicit port and no userinfo, query or fragment')

if __name__ == '__main__':
    check(sys.argv[1])
