"""Synthetic fault fixture, NEVER installed or selected by production defaults."""
import errno
import json
import os
from pathlib import Path
import socket
import sys
import time

request = json.loads(sys.stdin.buffer.read(2 * 1024 * 1024))
if request["operation"] == "_probe":
    p = request["payload"]
    allowed = Path(p["allowedPath"]).read_text() == "allowed-synthetic-probe"
    denied = False
    try:
        Path(p["deniedPath"]).read_bytes()
    except OSError as exc:
        denied = exc.errno in (errno.EACCES, errno.EPERM)
    network = False
    try:
        with socket.socket() as s:
            s.connect(("127.0.0.1", 9))
    except OSError as exc:
        network = exc.errno in (errno.EACCES, errno.EPERM)
    print(json.dumps({"probe": {"allowedRead": allowed, "deniedRead": denied, "networkDenied": network, "environmentNames": sorted(os.environ)}}))
elif request["payload"].get("fault") == "overflow":
    while True:
        sys.stdout.write("x" * 65536)
        sys.stdout.flush()
else:
    while True:
        time.sleep(0.01)
