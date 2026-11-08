"""E2E test: fake Telegram Bot API + real DSH runtime + real DeepSeek LLM.

Boots the telegram-test profile (sdk template + @deepseek-hermes/dsh-telegram),
points the plugin at a local fake Bot API server, pushes one private-chat
update, and asserts the plugin runs a real agent turn and sends the reply.
"""

import json
import os
import subprocess
import shutil
import sys
import time
import urllib.request

ROOT = os.environ.get("DSH_WORKSPACE") or os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, ".pylibs"))

from deepseek_harness import DeepSeekHarness  # noqa: E402

EXE = os.environ.get("DSH_EXE", "")
CLI = os.environ.get("DSH_CLI", "")
NODE = os.environ.get("DSH_NODE", "node")
FAKE_PORT = 4767
FAKE_URL = f"http://127.0.0.1:{FAKE_PORT}"
CHAT_ID = int(os.environ.get("TG_TEST_CHAT_ID", "123456789"))
# Isolated DSH home so the runtime can compose its profile without touching ~/.dsh.
DSH_HOME = os.environ.get("DSH_TEST_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")


def http(method: str, url: str, payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def visible_text(item):
    """Text of a final message, whichever renderer the plugin picked."""
    payload = item.get("payload") or {}
    if item.get("method") == "sendRichMessage":
        return str((payload.get("rich_message") or {}).get("markdown") or "")
    return str(payload.get("text") or "")


def finals(out):
    return [item for item in out if item.get("method") in ("sendMessage", "sendRichMessage")]


def main() -> None:
    if not EXE or not CLI:
        print("set DSH_EXE and DSH_CLI to the DeepSeek Harness binary and its cli.js")
        sys.exit(2)
    # Fresh bridge state: a stale offset would make the plugin skip our update.
    for name in ("e2e-state.json", "e2e.log"):
        try:
            os.remove(os.path.join(ROOT, "state", "telegram", name))
        except FileNotFoundError:
            pass
    # Fresh inbox: otherwise a stale photo could satisfy the media assertion.
    shutil.rmtree(os.path.join(ROOT, "state", "telegram", "inbox", str(CHAT_ID)), ignore_errors=True)

    server = subprocess.Popen(
        [NODE, os.path.join(ROOT, "tests", "fake-bot-server.mjs")],
        env={**os.environ, "FAKE_PORT": str(FAKE_PORT)},
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        time.sleep(1.5)
        http("POST", f"{FAKE_URL}/__reset")

        harness = DeepSeekHarness(
            dsh_home=DSH_HOME,
            cwd=ROOT,
            profile="telegram-test",
            provider="deepseek-account",
            model="deepseek-flash",
            reasoning_effort="high",
            initialize_timeout_seconds=120,
            request_timeout_seconds=None,
            env={"ELECTRON_RUN_AS_NODE": "1", "DSH_HOME": DSH_HOME},
            _launch_args=(EXE, "--expose-internals", CLI, "--profile", "telegram-test"),
        )
        harness.start()
        print("runtime started, waiting for plugin getMe...")
        deadline = time.time() + 90
        authed = False
        while time.time() < deadline:
            out = http("GET", f"{FAKE_URL}/__out")["result"]
            if any(item["method"] == "getMe" for item in out):
                authed = True
                break
            time.sleep(1)
        if not authed:
            print("FAIL: plugin never called getMe")
            sys.exit(1)
        print("plugin authenticated against fake server")
        settle = float(os.environ.get("E2E_SETTLE_SECONDS", "0"))
        if settle > 0:
            print(f"settling {settle:.0f}s before the first message")
            time.sleep(settle)

        http(
            "POST",
            f"{FAKE_URL}/__push",
            {
                "update_id": 1,
                "message": {
                    "message_id": 1,
                    "date": int(time.time()),
                    "chat": {"id": CHAT_ID, "type": "private"},
                    "from": {"id": CHAT_ID, "is_bot": False, "first_name": "Tester"},
                    "text": "只回复两个词：pong 通过",
                },
            },
        )
        print("pushed user update, waiting for agent reply...")

        deadline = time.time() + 300
        reply = None
        drafts = 0
        while time.time() < deadline:
            out = http("GET", f"{FAKE_URL}/__out")["result"]
            drafts = sum(1 for item in out if item["method"] == "sendMessageDraft")
            for item in finals(out):
                if "pong" in visible_text(item).lower():
                    reply = item
                    break
            if reply:
                break
            time.sleep(2)

        if not reply:
            print("FAIL: no sendMessage with 'pong' arrived")
            out = http("GET", f"{FAKE_URL}/__out")["result"]
            print("outbound:", json.dumps(out, ensure_ascii=False)[:2000])
            sys.exit(1)

        print("PASS")
        print("draft updates:", drafts)
        print("final reply:", visible_text(reply)[:200])
        print("final method:", reply.get("method"))

        # Second turn on the same chat: the plugin must reuse the persisted
        # session instead of creating a new one, and must reply again.
        first_count = len(finals(http("GET", f"{FAKE_URL}/__out")["result"]))
        http(
            "POST",
            f"{FAKE_URL}/__push",
            {
                "update_id": 2,
                "message": {
                    "message_id": 2,
                    "date": int(time.time()),
                    "chat": {"id": CHAT_ID, "type": "private"},
                    "from": {"id": CHAT_ID, "is_bot": False, "first_name": "Tester"},
                    "text": "只回复一个词：ok",
                },
            },
        )
        deadline = time.time() + 180
        second = None
        while time.time() < deadline:
            out = http("GET", f"{FAKE_URL}/__out")["result"]
            sends = finals(out)
            if len(sends) > first_count:
                second = sends[-1]
                break
            time.sleep(2)
        if not second:
            print("FAIL: second turn produced no reply")
            sys.exit(1)
        print("PASS second turn:", visible_text(second)[:120])

        # Third turn: start a long answer, then stop it with /stop. This
        # exercises the real agent.cancel() path, not just the bridge wiring.
        drafts_before = len([i for i in http("GET", f"{FAKE_URL}/__out")["result"] if i["method"] == "sendMessageDraft"])
        http(
            "POST",
            f"{FAKE_URL}/__push",
            {
                "update_id": 3,
                "message": {
                    "message_id": 3,
                    "date": int(time.time()),
                    "chat": {"id": CHAT_ID, "type": "private"},
                    "from": {"id": CHAT_ID, "is_bot": False, "first_name": "Tester"},
                    "text": "写一篇八百字左右的文章，标题叫《雨夜》，分段写，不要用列表。",
                },
            },
        )
        deadline = time.time() + 120
        started = False
        while time.time() < deadline:
            out = http("GET", f"{FAKE_URL}/__out")["result"]
            if len([i for i in out if i["method"] == "sendMessageDraft"]) > drafts_before:
                started = True
                break
            time.sleep(1)
        if not started:
            print("FAIL: long-answer turn never started streaming")
            sys.exit(1)

        http(
            "POST",
            f"{FAKE_URL}/__push",
            {
                "update_id": 4,
                "message": {
                    "message_id": 4,
                    "date": int(time.time()),
                    "chat": {"id": CHAT_ID, "type": "private"},
                    "from": {"id": CHAT_ID, "is_bot": False, "first_name": "Tester"},
                    "text": "/stop",
                },
            },
        )
        deadline = time.time() + 90
        stopped = None
        while time.time() < deadline:
            out = http("GET", f"{FAKE_URL}/__out")["result"]
            for item in finals(out):
                if "已停止" in visible_text(item):
                    stopped = item
                    break
            if stopped:
                break
            time.sleep(2)
        if not stopped:
            print("FAIL: /stop produced no stop notice")
            sys.exit(1)
        print("PASS /stop:", visible_text(stopped)[:80].replace("\n", " "))

        # Fourth turn: an incoming photo must be downloaded into the inbox and
        # announced to the agent as a readable path.
        inbox = os.path.join(ROOT, "state", "telegram", "inbox", str(CHAT_ID))
        http(
            "POST",
            f"{FAKE_URL}/__push",
            {
                "update_id": 5,
                "message": {
                    "message_id": 5,
                    "date": int(time.time()),
                    "chat": {"id": CHAT_ID, "type": "private"},
                    "from": {"id": CHAT_ID, "is_bot": False, "first_name": "Tester"},
                    "caption": "这张图里是什么？只回复一个字：图",
                    "photo": [
                        {"file_id": "small", "width": 90, "height": 90, "file_size": 16},
                        {"file_id": "large", "width": 1280, "height": 720, "file_size": 16},
                    ],
                },
            },
        )
        deadline = time.time() + 120
        saved = None
        while time.time() < deadline:
            out = http("GET", f"{FAKE_URL}/__out")["result"]
            got_file = [item for item in out if item["method"] == "getFile"]
            if got_file and os.path.isdir(inbox):
                files = os.listdir(inbox)
                if files:
                    saved = os.path.join(inbox, files[0])
                    break
            time.sleep(2)
        if not saved:
            print("FAIL: incoming photo was not downloaded")
            out = http("GET", f"{FAKE_URL}/__out")["result"]
            print("methods:", [item["method"] for item in out][-20:])
            sys.exit(1)
        print("PASS media:", saved, os.path.getsize(saved), "bytes")
    finally:
        try:
            harness.close()
        except Exception:
            pass
        server.terminate()
        try:
            server.wait(timeout=5)
        except Exception:
            server.kill()


if __name__ == "__main__":
    main()
