"""Actual zsh + zoxide + Node SDK transport, with deterministic Jev responses."""
import datetime
import json
import os
from pathlib import Path
import pty
import select
import shlex
import shutil
import signal
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent


def run():
    with tempfile.TemporaryDirectory(prefix="joxide-pty-") as directory:
        tmp = Path(directory).resolve()
        projects = tmp / "projects"
        paths = {name: projects / name for name in ["identity-svc", "workers playground", "frontend-one", "frontend-two", "literal$(touch SHOULD_NOT_EXIST)"]}
        for path in paths.values():
            path.mkdir(parents=True)
        (paths["identity-svc"] / "package.json").write_text(json.dumps({"name": "identity", "description": "Authentication backend with OAuth sessions"}))
        (paths["workers playground"] / "README.md").write_text("# Playground\n\nCloudflare Workers chat experiment.\n")
        snapshot = tmp / "state"
        request = tmp / "request.json"
        mock = tmp / "mock-fetch.mjs"
        mock.write_text("""import { writeFileSync } from 'node:fs';
globalThis.fetch = async (_url, init) => {
  const request = JSON.parse(init.body);
  writeFileSync(process.env.JOXIDE_TEST_REQUEST, JSON.stringify(request));
  const answers = Object.fromEntries(request.state.directories.map(item => [item.id, {
    type: 'noul', noul: request.state.query === 'auth backend' && item.description.includes('Authentication') ? 0.98 : 0.02
  }]));
  return new Response(JSON.stringify({ model: 'fixture', answers, usage: { input_tokens: 100, output_tokens: 10 } }), { headers: { 'Content-Type': 'application/json' } });
};
""")
        node = tmp / "node-fixture"
        node.write_text("#!/bin/sh\nexec " + shlex.quote(shutil.which("node")) + " --import " + shlex.quote(str(mock)) + ' "$@"\n')
        node.chmod(0o755)
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(projects)
            env = dict(os.environ)
            env.update(TERM="xterm-256color", ZDOTDIR=str(tmp), TYPESAFE_API_KEY="fixture-only",
                       JOXIDE_DATA_DIR=str(tmp / "jump-data"), _ZO_DATA_DIR=str(tmp / "zoxide-data"),
                       _ZO_EXCLUDE_DIRS=str(tmp / "excluded"), JOXIDE_NODE=str(node), JOXIDE_TEST_REQUEST=str(request))
            os.execve("/bin/zsh", ["zsh", "-f"], env)
        transcript = bytearray()

        def send(text):
            os.write(fd, text.encode())

        def pump(seconds=0.1):
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                ready, _, _ = select.select([fd], [], [], max(0, min(0.05, end - time.monotonic())))
                if ready:
                    try:
                        transcript.extend(os.read(fd, 65536))
                    except OSError:
                        break

        def begin(command):
            snapshot.unlink(missing_ok=True)
            send(command + '; print -rl -- "$?" "$PWD" > ' + shlex.quote(str(snapshot)) + "\r")

        def finish():
            deadline = time.monotonic() + 6
            while time.monotonic() < deadline:
                pump(0.03)
                if snapshot.exists():
                    lines = snapshot.read_text().splitlines()
                    if len(lines) >= 2:
                        return int(lines[0]), Path(lines[1])
            raise AssertionError("Command did not finish")

        def command(text):
            begin(text)
            return finish()

        def wait_for(text):
            start = len(transcript)
            deadline = time.monotonic() + 6
            while time.monotonic() < deadline:
                pump(0.03)
                if text.encode() in transcript[start:]:
                    return
            raise AssertionError("Missing terminal output: " + text)

        try:
            pump(0.2)
            code, cwd = command("PROMPT='JUMP> '; RPROMPT=; HISTFILE=" + shlex.quote(str(tmp / "history")) + "; HISTSIZE=1000; SAVEHIST=0; bindkey -e; _test_accept_line=${widgets[accept-line]}; source " + shlex.quote(str(ROOT / "joxide.plugin.zsh")))
            assert code == 0
            assert command('[[ ${widgets[accept-line]} == "$_test_accept_line" ]]')[0] == 0
            print("PASS: loading the plugin preserves Enter behavior")

            assert command("jctl index " + shlex.quote(str(projects)))[0] == 0
            code, cwd = command("j identity")
            assert code == 0 and cwd == paths["identity-svc"]
            assert not request.exists(), "Name navigation must not call Jev"
            assert str(cwd) in (tmp / "jump-data/visits.tsv").read_text()
            print("PASS: actual zoxide name matching changes the parent shell directory offline")

            code, cwd = command("j auth backend")
            assert code == 0 and cwd == paths["identity-svc"]
            body = json.loads(request.read_text())
            assert body["state"]["query"] == "auth backend"
            assert len(body["questions"]) >= 5
            print("PASS: semantic query goes through the real SDK and selects an indexed project")

            begin("j frontend")
            wait_for("Jump [")
            send("2\r")
            code, cwd = finish()
            assert code == 0 and cwd in [paths["frontend-one"], paths["frontend-two"]]
            selected = cwd
            begin("j frontend")
            wait_for("Jump [")
            send("\r")
            assert finish() == (2, selected)
            print("PASS: ambiguous matches offer a numbered picker; cancellation preserves cwd")

            begin("j frontend")
            wait_for("Jump [")
            send("$(touch SHOULD_NOT_EXIST)\r")
            assert finish() == (2, selected)
            assert not (selected / "SHOULD_NOT_EXIST").exists()
            print("PASS: picker input is validated, never evaluated as shell code")

            literal = paths["literal$(touch SHOULD_NOT_EXIST)"]
            assert command("j " + shlex.quote(str(literal))) == (0, literal)
            assert not (selected / "SHOULD_NOT_EXIST").exists()
            spaced = paths["workers playground"]
            assert command("j " + shlex.quote(str(spaced))) == (0, spaced)
            assert command("j -")[1] == literal
            print("PASS: spaces, shell metacharacters, and previous-directory navigation work")

            yesterday = datetime.datetime.now().replace(hour=12, minute=0, second=0, microsecond=0) - datetime.timedelta(days=1)
            with (tmp / "jump-data/visits.tsv").open("a") as file:
                file.write(str(int(yesterday.timestamp())) + "\t" + str(spaced) + "\n")
            assert command("j yesterday") == (0, spaced)
            print("PASS: yesterday uses recorded visits with no model date arithmetic")

            request.unlink()
            assert command("j --local impossible-project") == (2, spaced)
            assert not request.exists()
            assert command("j no matching project") == (2, spaced)
            assert command("unset TYPESAFE_API_KEY; j auth backend") == (1, spaced)
            print("PASS: no-match and API-key errors preserve cwd; --local avoids the API")

            excluded = tmp / "excluded"
            excluded.mkdir()
            assert command("cd " + shlex.quote(str(excluded)))[0] == 0
            assert str(excluded) not in (tmp / "jump-data/visits.tsv").read_text()
            assert command("source " + shlex.quote(str(ROOT / "joxide.plugin.zsh")) + '; _test_hooks=("${(@M)chpwd_functions:#_joxide_record}"); (( $#_test_hooks == 1 ))')[0] == 0
            assert b"bad math expression" not in transcript
            print("PASS: directory exclusions are honored and reloading does not duplicate hooks")
        except Exception:
            print("PTY transcript:", transcript.decode(errors="replace"))
            raise
        finally:
            os.kill(pid, signal.SIGTERM)
            os.close(fd)
            os.waitpid(pid, 0)


if __name__ == "__main__":
    run()
