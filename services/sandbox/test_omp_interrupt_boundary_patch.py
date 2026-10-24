"""Fail-closed behavior for the OMP interrupted-request context patch."""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("apply_omp_interrupt_boundary_patch.py")
SPEC = importlib.util.spec_from_file_location("omp_interrupt_boundary_patch", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
PATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCH)

SOURCE_FIXTURE = """import {
\tcreateBranchSummaryMessage,
\tcreateCompactionSummaryMessage,
\tcreateCustomMessage,
\tINTERRUPTED_THINKING_MESSAGE_TYPE,
\tisEmptyErrorTurn,
\tPREWALK_PLAN_MESSAGE_TYPE,
\tVIBE_MODE_CONTEXT_MESSAGE_TYPE,
} from "./messages";

export function buildSessionContext(
\tentries: unknown[],
): void {
\t// Error/abort assistant turns are transcript events.
\tif (!options?.transcript) {
\t\tfor (let i = messages.length - 1; i >= 0; i--) {
\t\t\tconst message = messages[i];
\t\t\tif (message?.role !== "assistant") continue;
\t\t\tif (message.stopReason !== "aborted" && message.stopReason !== "error") continue;
\t\t\tconst next = messages[i + 1];
\t\t\tif (next?.role === "custom" && next.customType === INTERRUPTED_THINKING_MESSAGE_TYPE) continue;
\t\t\tconst droppedToolCallIds = new Set<string>();
\t\t\tfor (const block of message.content) {
\t\t\t\tif (block.type === "toolCall") droppedToolCallIds.add(block.id);
\t\t\t}
\t\t\tmessages.splice(i, 1);
\t\t\tif (droppedToolCallIds.size > 0) {
\t\t\t\tfor (let j = messages.length - 1; j >= i; j--) {}
\t\t\t}
\t\t}
\t}
}
"""

BUNDLE_FIXTURE = (
    'prefix;if(R.splice(_,1),N.size>0)for(let q=R.length-1;q>=_;q--){'
    "R.splice(q,1)}"
    "async retry(){let e=this.#e.agent.state.messages;"
    "else{let s=this.#e.sessionManager.buildSessionContext({transcript:!0}).messages;"
    "if(AQs(s)===void 0)return!1;let n=Ybr(e);"
    "if(n!==void 0)await this.#fe(e,n)}"
    "return!0}"
    'function p0a(e,t){switch(e.role){case"bashExecution":return[]}'
    'case"custom":{if(!bO(e.content))return[];return[]}'
    "{let r,i;if(n&&t>s.length&&s.length>0&&e[s.length-1]===s.tail"
    "&&s.prefixOutputLen<=s.output.length)r=s.output.slice(0,s.prefixOutputLen),"
    "i=s.length-1;else r=[],i=0;let a=0;}"
    'let u=e[l],p=u.role==="assistant"&&t0a(e,l),c=c0a(u,p);'
    "for(let d of c)r.push(d)"
    "function c0a(e,t){let s=Xvs.get(e);if(s!==void 0&&s.interruptedNext===t)"
    "return s.fragment;let n=p0a(e,t);for(let o of n)DP(o,e);"
    "return Xvs.set(e,{interruptedNext:t,fragment:n}),n}"
    "return eEs.set(e,{generation:Zvs,length:t,output:r,tail:o,"
    "prefixOutputLen:a}),r"
    "suffix"
)

MESSAGES_FIXTURE = """type AgentMessage = any;
type Message = any;

interface ConvertMemoEntry {
\tinterruptedNext: boolean;
\tfragment: Message[];
}
const convertCache = new WeakMap<AgentMessage, ConvertMemoEntry>();
const convertArrayCache = new WeakMap<AgentMessage[], ConvertArrayMemo>();
let convertGeneration = 0;

interface ConvertArrayMemo {
\tgeneration: number;
\tlength: number;
\toutput: Message[];
\ttail: AgentMessage | undefined;
\tprefixOutputLen: number;
}

function convertOne(m: AgentMessage, interruptedNext: boolean): Message[] {
\tswitch (m.role) {
\t\tcase "custom": {
\t\t\tif (!isCustomMessageContent(m.content)) return [];
\t\t\treturn [];
\t\t}
\t\tdefault:
\t\t\treturn [];
\t}
}

function convertOneCached(m: AgentMessage, interruptedNext: boolean): Message[] {
\tconst cached = convertCache.get(m);
\tif (cached !== undefined && cached.interruptedNext === interruptedNext) return cached.fragment;
\tconst fragment = convertOne(m, interruptedNext);
\tfor (const message of fragment) copyPerCallContextMessage(message, m);
\tconvertCache.set(m, { interruptedNext, fragment });
\treturn fragment;
}

export function convertToLlm(messages: AgentMessage[]): Message[] {
\tconst len = messages.length;
\tconst memo = convertArrayCache.get(messages);
\tconst sameGeneration = memo !== undefined;
\tconst tail = len > 0 ? messages[len - 1] : undefined;
\tlet out: Message[];
\tlet start: number;
\tif (
\t\tsameGeneration &&
\t\tlen > memo.length &&
\t\tmemo.length > 0 &&
\t\tmessages[memo.length - 1] === memo.tail &&
\t\tmemo.prefixOutputLen <= memo.output.length
\t) {
\t\tout = memo.output.slice(0, memo.prefixOutputLen);
\t\tstart = memo.length - 1;
\t} else {
\t\tout = [];
\t\tstart = 0;
\t}

\tlet prefixOutputLen = 0;
\tfor (let i = start; i < len; i++) {
\t\tif (i === len - 1) prefixOutputLen = out.length;
\t\tconst m = messages[i];
\t\tconst interruptedNext = m.role === "assistant" && followedByInterruptedThinking(messages, i);
\t\tconst fragment = convertOneCached(m, interruptedNext);
\t\tfor (const msg of fragment) out.push(msg);
\t}

\tconvertArrayCache.set(messages, {
\t\tgeneration: convertGeneration,
\t\tlength: len,
\t\toutput: out,
\t\ttail,
\t\tprefixOutputLen,
\t});
\treturn out;
}
"""

RECOVERY_FIXTURE = """import { getLatestCompactionEntry } from "./session-context";
import { assistantTurnProducedOutput, isEmptyAssistantStop, isEmptyErrorTurn } from "./messages";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "./session-entries";

export class TurnRecovery {
\tasync retry(): Promise<boolean> {
\t\tif (this.#host.isStreaming()) return false;
\t\tconst messages = this.#host.agent.state.messages;
\t\tif (activeTurnEnd !== undefined) {
\t\t\tconst replayStart = toolReplayStart(messages);
\t\t\tif (replayStart !== undefined) {
\t\t\t\tawait this.#stripForToolReplay(messages, replayStart);
\t\t\t}
\t\t} else {
\t\t\tconst transcriptMessages = this.#host.sessionManager.buildSessionContext({ transcript: true }).messages;
\t\t\tif (retryableAssistantTurnEnd(transcriptMessages) === undefined) return false;
\t\t\tconst replayStart = toolReplayStart(messages);
\t\t\tif (replayStart !== undefined) await this.#stripForToolReplay(messages, replayStart);
\t\t}
\t\treturn true;
\t}
}
"""


class OmpInterruptBoundaryPatchTest(unittest.TestCase):
    def _package(self, root: Path, *, version: str = "18.8.6") -> Path:
        (root / "src" / "session").mkdir(parents=True)
        (root / "dist").mkdir()
        (root / "package.json").write_text(
            json.dumps({"name": "@oh-my-pi/pi-coding-agent", "version": version})
        )
        (root / "src" / "session" / "session-context.ts").write_text(SOURCE_FIXTURE)
        (root / "src" / "session" / "turn-recovery.ts").write_text(RECOVERY_FIXTURE)
        (root / "src" / "session" / "messages.ts").write_text(MESSAGES_FIXTURE)
        (root / "dist" / "cli.js").write_text(BUNDLE_FIXTURE)
        return root

    def test_rejects_a_second_application(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = self._package(Path(tmp))
            PATCH.patch_package(root, official_sha256=None)

            with self.assertRaisesRegex(PATCH.PatchError, "already patched"):
                PATCH.patch_package(root, official_sha256=None)

    def test_rejects_a_version_drift(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = self._package(Path(tmp), version="18.8.7")

            with self.assertRaisesRegex(PATCH.PatchError, "expected version 18.8.6"):
                PATCH.patch_package(root, official_sha256=None)

    def test_rejects_a_hash_drift_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = self._package(Path(tmp))

            with self.assertRaisesRegex(PATCH.PatchError, "does not match the pinned"):
                PATCH.patch_package(root, official_sha256={"dist/cli.js": "0" * 64})

            self.assertEqual(
                (root / "src" / "session" / "session-context.ts").read_text(),
                SOURCE_FIXTURE,
            )
            self.assertEqual(
                (root / "src" / "session" / "messages.ts").read_text(),
                MESSAGES_FIXTURE,
            )
            self.assertEqual(
                (root / "src" / "session" / "turn-recovery.ts").read_text(),
                RECOVERY_FIXTURE,
            )
            self.assertEqual((root / "dist" / "cli.js").read_text(), BUNDLE_FIXTURE)

    def test_does_not_mutate_hardlinked_install_and_keeps_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = self._package(Path(tmp))
            bundle_path = root / "dist" / "cli.js"
            bundle_path.chmod(0o755)
            cache_path = Path(tmp) / "cache.js"
            os.link(bundle_path, cache_path)

            PATCH.patch_package(root, official_sha256=None)

            self.assertEqual(cache_path.read_text(), BUNDLE_FIXTURE)
            self.assertNotEqual(bundle_path.stat().st_ino, cache_path.stat().st_ino)
            self.assertIn(PATCH.CANCELLATION_MESSAGE_TYPE, bundle_path.read_text())
            self.assertEqual(stat.S_IMODE(bundle_path.stat().st_mode), 0o755)

    def test_rejects_missing_anchors_without_partial_writes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = self._package(Path(tmp))
            source_path = root / "src" / "session" / "session-context.ts"
            source_path.write_text(SOURCE_FIXTURE.replace("\tmessages.splice(i, 1);", ""))

            with self.assertRaisesRegex(PATCH.PatchError, "error/abort drop loop"):
                PATCH.patch_package(root, official_sha256=None)

            self.assertNotIn("USER_INTERRUPT_CANCELLED_MESSAGE_TYPE", source_path.read_text())
            self.assertEqual(
                (root / "src" / "session" / "messages.ts").read_text(),
                MESSAGES_FIXTURE,
            )
            self.assertEqual(
                (root / "src" / "session" / "turn-recovery.ts").read_text(),
                RECOVERY_FIXTURE,
            )
            self.assertEqual((root / "dist" / "cli.js").read_text(), BUNDLE_FIXTURE)


if __name__ == "__main__":
    unittest.main()
