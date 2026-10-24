use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const KEY: &str = "slack:C123:123.456";
const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/omp");
const READY: &str =
    r#"{"type":"ready","supportedProtocolVersions":[1,2],"maxReassembledFrameBytes":67108864}"#;

/// Answers startup before replaying recordings from OMP 18.8.6 against a
/// loopback provider. The background gate pauses before session_settled.
fn fake_omp(dir: &std::path::Path) -> PathBuf {
    let script = r##"#!/bin/sh
printf '%s|%s\n' "$$" "$*" >> '@DIR@/argv'
if [ -n "$OMP_TEST_STDERR" ]; then printf 'api_key=%s\n' "$OMP_TEST_STDERR" >&2; fi
printf '%s\n' '@READY@'
while IFS= read -r line; do
    printf '%s\n' "$line" >> '@DIR@/stdin'
    kind=${line##*\"type\":\"}
    kind=${kind%%\"*}
    if [ "$OMP_TEST_FAULT" = "$kind" ]; then
        printf '{"type":"response","id":"centaur-%s","command":"%s","success":false,"error":"startup rejected"}\n' "$kind" "$kind"
        continue
    fi
    case "$kind" in
    negotiate_protocol)
        case "$OMP_TEST_FAULT" in
        eof) exit 0 ;;
        v1) printf '%s\n' '{"id":"centaur-negotiate_protocol","type":"response","command":"negotiate_protocol","success":true,"data":{"protocolVersion":1}}' ;;
        *)
            printf '%s\n' '{"type":"message_end","messageId":"early","message":{"role":"assistant","content":[{"type":"text","text":"not part of the turn"}]}}' '{"id":"unrelated","type":"response","command":"negotiate_protocol","success":true}'
            printf '%s\n' '{"id":"centaur-negotiate_protocol","type":"response","command":"negotiate_protocol","success":true,"data":{"protocolVersion":2}}' ;;
        esac ;;
    open_session)
        cancelled=false error=
        case "$line" in
        *'"modelId":"missing"'*) error='Model not found: custom/missing' ;;
        *'"provider":"broken"'*) error='Model not found: broken/glm-5.2-fp8' ;;
        *'"modelId"'*) ;;
        *) if [ "$OMP_TEST_FAULT" = restore_model ]; then error='Could not restore model custom/saved'; fi ;;
        esac
        if [ "$OMP_TEST_FAULT" = cancelled ]; then cancelled=true; fi
        if [ -n "$error" ]; then
            printf '{"id":"centaur-open_session","type":"response","command":"open_session","success":false,"error":"%s"}\n' "$error"
        else
            printf '{"id":"centaur-open_session","type":"response","command":"open_session","success":true,"data":{"cancelled":%s}}\n' "$cancelled"
        fi ;;
    get_state)
        printf '%s\n' '{"id":"centaur-get_state","type":"response","command":"get_state","success":true,"data":{"model":{"provider":"litellm","id":"restored-model"}}}' ;;
    set_model)
        case "$line" in
        *'"modelId":"missing-bare"'*) printf '%s\n' '{"id":"centaur-set_model","type":"response","command":"set_model","success":false,"error":"Model not found: missing-bare"}' ;;
        *) printf '%s\n' '{"id":"centaur-set_model","type":"response","command":"set_model","success":true,"data":{"provider":"litellm","id":"ok"}}' ;;
        esac ;;
    abort)
        printf '%s\n' '{"type":"response","command":"abort","success":true}' '{"type":"prompt_result","id":"prompt-1","agentInvoked":true,"status":"aborted","sessionSettled":true}' ;;
    prompt)
        case "$line" in *'"message":"/local-only"'*)
            printf '%s\n' '{"type":"command_output","text":"Available commands:\n/local-only\n"}' '{"type":"response","command":"prompt","success":true,"data":{"agentInvoked":false}}'
            continue ;;
        esac
        # Accepts the prompt and never answers it: no acknowledgement at all.
        case "$line" in *'"message":"no_ack"'*) continue ;; esac
        printf '%s\n' '{"type":"response","command":"prompt","success":true}'
        case "$line" in
        # Accepted, then silent: an acknowledged run whose model is slow.
        *'"message":"quiet_after_ack"'*) ;;
        # A single physical line past the reader's bound, mid-run.
        *'"message":"oversized_line"'*)
            head -c 1100000 /dev/zero | tr '\0' 'x'
            printf '\n' ;;
        *'"message":"slow"'*) printf '%s\n' '{"type":"tool_execution_start","toolCallId":"slow","toolName":"bash","args":{"command":"sleep 60"}}' ;;
        *'"message":"extension_error"'*)
            printf '%s\n' '{"type":"agent_start"}' '{"type":"extension_error","message":"extension boom"}'
            cat '@FIXTURES@/text.jsonl' ;;
        *'"message":"persistence_notice"'*)
            printf '%s\n' '{"type":"notice","level":"error","source":"session-persistence","message":"persist failed"}' ;;
        *'"message":"trailing_settle"'*)
            cat '@FIXTURES@/text.jsonl'
            ( sleep 2; printf '%s\n' '{"type":"session_settled"}' ) & ;;
        *'"message":"gated_background"'*)
            while IFS= read -r frame; do
                printf '%s\n' "$frame"
                case "$frame" in *'"sessionSettled":false'*)
                    : > '@DIR@/paused'
                    while [ ! -f '@DIR@/release' ]; do sleep 0.01; done ;;
                esac
            done < '@FIXTURES@/background.jsonl' ;;
        *'"message":"thinking_tool"'*) cat '@FIXTURES@/thinking_tool.jsonl' ;;
        *'"message":"tool"'*) cat '@FIXTURES@/tool.jsonl' ;;
        *'"message":"provider_error"'*) cat '@FIXTURES@/provider_error.jsonl' ;;
        *'"message":"truncated_stream"'*) cat '@FIXTURES@/truncated_stream.jsonl' ;;
        *'"message":"custom"'*) cat '@DIR@/turn.jsonl' ;;
        *) cat '@FIXTURES@/text.jsonl' ;;
        esac ;;
    *) printf '{"type":"response","id":"centaur-%s","command":"%s","success":true}\n' "$kind" "$kind" ;;
    esac
done
"##.replace("@DIR@", &dir.to_string_lossy()).replace("@FIXTURES@", FIXTURES).replace("@READY@", READY);
    let path = dir.join("omp");
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

/// The native session directory OMP opens for a thread key or thread id.
fn session_dir(key: &str) -> String {
    let digest: [u8; 32] = Sha256::digest(key.as_bytes()).into();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

struct Server {
    dir: PathBuf,
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Receiver<Value>,
    timeout: Duration,
}

impl Server {
    fn new(extra_env: &[(&str, &str)]) -> Self {
        Self::mode(extra_env, "blocks")
    }

    fn mode(extra_env: &[(&str, &str)], mode: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("omp-stdio-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let binary = fake_omp(&dir);
        Self::with_binary(dir, mode, binary.as_os_str(), extra_env)
    }

    fn with_binary(dir: PathBuf, mode: &str, binary: &OsStr, extra_env: &[(&str, &str)]) -> Self {
        let stderr_log = dir.join("server.stderr");
        let mut child = Command::new(env!("CARGO_BIN_EXE_harness-server"))
            .args(["omp", "--mode", mode])
            .current_dir(&dir)
            .env("OMP_BIN", binary)
            .env("CENTAUR_OMP_SESSION_ROOT", dir.join("sessions"))
            .env_remove("OMP_MODEL")
            .env_remove("CENTAUR_THREAD_KEY")
            .env_remove("OMP_TEST_FAULT")
            .env_remove("OMP_TEST_STDERR")
            .envs(extra_env.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(
                std::fs::File::create(&stderr_log).expect("server stderr log"),
            ))
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(serde_json::from_str(&line).unwrap()).is_err() {
                    break;
                }
            }
        });
        Self {
            dir,
            child,
            stdin,
            stdout: rx,
            timeout: Duration::from_secs(10),
        }
    }

    fn send(&mut self, value: Value) {
        writeln!(self.stdin.as_mut().unwrap(), "{value}").unwrap();
    }

    fn user(&mut self, message: &str, extra: Value) {
        let mut value = json!({"type": "user", "thread_key": KEY, "text": message});
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        self.send(value);
    }

    fn until(&self, predicate: impl Fn(&Value) -> bool) -> Vec<Value> {
        let deadline = Instant::now() + self.timeout;
        let mut values = Vec::new();
        loop {
            let value = self
                .stdout
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            let done = predicate(&value);
            values.push(value);
            if done {
                return values;
            }
        }
    }

    fn read_until(&self, method: &str) -> Vec<Value> {
        self.until(|value| value["method"] == method)
    }

    fn turn(&mut self, message: &str, extra: Value) -> Vec<Value> {
        self.user(message, extra);
        self.read_until("turn/completed")
    }

    fn commands(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.join("stdin"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn custom(&mut self, frames: &[Value]) -> Vec<Value> {
        let content = frames
            .iter()
            .map(|frame| format!("{frame}\n"))
            .collect::<String>();
        std::fs::write(self.dir.join("turn.jsonl"), content).unwrap();
        self.turn("custom", json!({}))
    }

    fn paused(&self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.dir.join("paused").exists() {
            assert!(Instant::now() < deadline, "fake never paused");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn release(&self) {
        std::fs::write(self.dir.join("release"), "").unwrap();
    }

    fn close(&mut self) {
        self.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(2);
        while matches!(self.child.try_wait(), Ok(None)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::fs::write(self.dir.join("release"), "");
        self.close();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn items<'a>(turn: &'a [Value], method: &str, kind: &str) -> Vec<&'a Value> {
    turn.iter()
        .filter(|event| event["method"] == method)
        .map(|event| &event["params"]["item"])
        .filter(|item| item["type"] == kind)
        .collect()
}

fn status(turn: &[Value]) -> &Value {
    &turn.last().unwrap()["params"]["turn"]["status"]
}
fn result() -> Value {
    json!({"type": "prompt_result", "status": "completed", "sessionSettled": true})
}
fn kinds(commands: &[Value]) -> Vec<&str> {
    commands
        .iter()
        .map(|command| command["type"].as_str().unwrap())
        .collect()
}

#[test]
fn startup_renders_final_text_and_reasoning_restores_default() {
    let mut server = Server::new(&[("OMP_MODEL", "custom/new-model")]);
    let turn = server.turn("text", json!({"reasoning": "none"}));
    assert_eq!(status(&turn), "completed");
    let messages = items(&turn, "item/completed", "agentMessage");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["text"], "Hello from the loopback mock.");
    assert_eq!(messages[0]["phase"], "final_answer");
    let first = server.commands();
    assert_eq!(
        kinds(&first),
        [
            "negotiate_protocol",
            "set_event_filter",
            "open_session",
            "set_thinking_level",
            "set_cache_warming",
            "set_thinking_level",
            "prompt",
        ]
    );
    assert_eq!(
        first[2]["sessionDir"],
        server
            .dir
            .join("sessions")
            .join(session_dir(KEY))
            .to_string_lossy()
            .as_ref()
    );
    assert_eq!(first[2]["provider"], "custom");
    assert_eq!(first[2]["modelId"], "new-model");
    // A respawned process must not inherit a saved level from an earlier turn.
    assert_eq!(first[3]["level"], "inherit");
    assert_eq!(first[5]["level"], "off");
    assert_eq!(status(&server.turn("text", json!({}))), "completed");
    assert_eq!(
        &server.commands()[first.len()..],
        [
            json!({"type": "set_thinking_level", "level": "inherit"}),
            json!({"type": "prompt", "message": "text"})
        ]
    );
    assert_eq!(
        std::fs::read_to_string(server.dir.join("argv"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[test]
fn recorded_tools_and_thinking_project_to_distinct_complete_items() {
    let mut server = Server::new(&[]);
    for scenario in ["tool", "thinking_tool"] {
        let turn = server.turn(scenario, json!({}));
        assert_eq!(status(&turn), "completed", "{turn:#?}");
        let commands = items(&turn, "item/completed", "commandExecution");
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0]["command"], "echo e2e-ok");
        assert!(
            commands[0]["aggregatedOutput"]
                .as_str()
                .unwrap()
                .starts_with("e2e-ok\n")
        );
        assert_eq!(commands[0]["exitCode"], 0);
        assert_eq!(commands[0]["status"], "completed");
        if scenario == "thinking_tool" {
            let reasoning = items(&turn, "item/completed", "reasoning");
            assert_eq!(reasoning.len(), 2);
            assert_ne!(reasoning[0]["id"], reasoning[1]["id"]);
            assert_eq!(
                reasoning[0]["content"],
                json!(["The user wants bash. Run echo e2e-ok first."])
            );
            assert_eq!(
                reasoning[1]["content"],
                json!(["The command printed e2e-ok."])
            );
            for item in &reasoning {
                let streamed: String = turn
                    .iter()
                    .filter(|event| {
                        event["method"] == "item/reasoning/textDelta"
                            && event["params"]["itemId"] == item["id"]
                    })
                    .map(|event| event["params"]["delta"].as_str().unwrap())
                    .collect();
                assert_eq!(item["content"], json!([streamed]));
            }
            let message_id = reasoning[1]["id"]
                .as_str()
                .unwrap()
                .rsplit_once('-')
                .unwrap()
                .0;
            let thinking_delta = turn
                .iter()
                .position(|event| {
                    event["method"] == "item/reasoning/textDelta"
                        && event["params"]["itemId"] == reasoning[1]["id"]
                })
                .unwrap();
            let text_started = turn
                .iter()
                .position(|event| {
                    event["method"] == "item/started"
                        && event["params"]["item"]["type"] == "agentMessage"
                        && event["params"]["item"]["id"]
                            .as_str()
                            .unwrap()
                            .rsplit_once('-')
                            .unwrap()
                            .0
                            == message_id
                })
                .unwrap();
            assert!(
                thinking_delta < text_started,
                "thinking must precede text from the same message"
            );
        }
    }
}

#[test]
fn failed_bash_keeps_native_exit_code() {
    let mut server = Server::new(&[]);
    let turn = server.custom(&[
        json!({"type": "tool_execution_start", "toolCallId": "bash", "toolName": "bash", "args": {"command": "exit 27"}}),
        json!({"type": "tool_execution_end", "toolCallId": "bash", "isError": true, "result": {"content": [{"type": "text", "text": "Command exited with code 27"}], "details": {"exitCode": 27}}}), result(),
    ]);
    let commands = items(&turn, "item/completed", "commandExecution");
    assert_eq!(commands[0]["status"], "failed");
    assert_eq!(commands[0]["exitCode"], 27);
}

#[test]
fn provider_and_truncated_stream_errors_do_not_render_failed_attempts() {
    let mut server = Server::new(&[]);
    for (scenario, error) in [
        ("provider_error", "Mock provider rejected the request"),
        ("truncated_stream", "stream ended before message_stop"),
    ] {
        let turn = server.turn(scenario, json!({}));
        assert_eq!(status(&turn), "failed");
        assert!(
            turn.last().unwrap()["params"]["turn"]["error"]["message"]
                .as_str()
                .unwrap()
                .contains(error)
        );
        assert!(items(&turn, "item/completed", "agentMessage").is_empty());
    }
}

#[test]
fn thinking_streamed_by_a_failed_attempt_completes_before_the_retry() {
    let mut server = Server::new(&[]);
    let thinking = |message: &str, delta: &str| {
        json!({"type": "message_update", "messageId": message, "message": {"role": "assistant"},
            "assistantMessageEvent": {"type": "thinking_delta", "contentIndex": 0, "delta": delta}})
    };
    let turn = server.custom(&[
        thinking("attempt-1", "Checking first."),
        json!({"type": "message_end", "messageId": "attempt-1", "message": {"role": "assistant", "content": [], "stopReason": "error", "errorMessage": "overloaded"}}),
        thinking("attempt-2", "Checking again."),
        json!({"type": "message_end", "messageId": "attempt-2", "message": {"role": "assistant", "stopReason": "stop", "content": [
            {"type": "thinking", "thinking": "Checking again."}, {"type": "text", "text": "Done."}]}}),
        result(),
    ]);
    assert_eq!(status(&turn), "completed");
    let ids = |method: &str| -> Vec<Value> {
        turn.iter()
            .filter(|event| event["method"] == method)
            .map(|event| event["params"]["item"]["id"].clone())
            .collect()
    };
    let completed = ids("item/completed");
    for id in ids("item/started") {
        assert!(completed.contains(&id), "{id} started but never completed");
    }
    let reasoning: Vec<_> = items(&turn, "item/completed", "reasoning")
        .into_iter()
        .map(|item| item["content"].clone())
        .collect();
    assert_eq!(
        reasoning,
        [json!(["Checking first."]), json!(["Checking again."])]
    );
    let messages = items(&turn, "item/completed", "agentMessage");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["text"], "Done.");
}

#[test]
fn prompt_rejection_retains_child_and_unknown_result_fails() {
    let mut server = Server::new(&[]);
    for command in ["prompt", "parse"] {
        let turn = server.custom(&[
            json!({"type": "response", "command": command, "success": false, "error": "rejected"}),
        ]);
        assert_eq!(status(&turn), "failed");
        assert_eq!(
            turn.last().unwrap()["params"]["turn"]["error"]["message"],
            format!("omp {command}: rejected")
        );
        assert_eq!(status(&server.turn("text", json!({}))), "completed");
    }
    let turn = server
        .custom(&[json!({"type": "prompt_result", "status": "unknown", "sessionSettled": true})]);
    assert_eq!(status(&turn), "failed");
    assert_eq!(
        std::fs::read_to_string(server.dir.join("argv"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[test]
fn prompt_handled_without_the_agent_completes_the_turn_with_its_output() {
    let mut server = Server::new(&[]);
    let turn = server.turn("/local-only", json!({}));
    assert_eq!(status(&turn), "completed");
    let messages = items(&turn, "item/completed", "agentMessage");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["text"], "Available commands:\n/local-only\n");
    assert_eq!(messages[0]["phase"], "final_answer");
    assert!(items(&turn, "item/completed", "dynamicToolCall").is_empty());
    assert_eq!(status(&server.turn("text", json!({}))), "completed");
    assert_eq!(
        std::fs::read_to_string(server.dir.join("argv"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[test]
fn mid_run_extension_error_fails_the_turn_only_after_it_settles() {
    let mut server = Server::new(&[]);
    let turn = server.turn("extension_error", json!({}));
    assert_eq!(status(&turn), "failed");
    assert_eq!(
        turn.last().unwrap()["params"]["turn"]["error"]["message"],
        "extension boom"
    );
    // The error outranked the successful result but arrived mid-run: the run
    // still settled, so its output is complete and the process is reused.
    assert_eq!(items(&turn, "item/completed", "agentMessage").len(), 1);
    // The next turn starts clean: nothing of the failed run leaks into it.
    let next = server.turn("text", json!({}));
    assert_eq!(status(&next), "completed");
    let messages = items(&next, "item/completed", "agentMessage");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["text"], "Hello from the loopback mock.");
    assert_eq!(
        std::fs::read_to_string(server.dir.join("argv"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[test]
fn session_persistence_notice_fails_the_turn_and_replaces_the_process() {
    let mut server = Server::new(&[]);
    let turn = server.turn("persistence_notice", json!({}));
    assert_eq!(status(&turn), "failed");
    assert!(
        turn.last().unwrap()["params"]["turn"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("session persistence failed")
    );
    assert_eq!(status(&server.turn("text", json!({}))), "completed");
    assert_eq!(
        std::fs::read_to_string(server.dir.join("argv"))
            .unwrap()
            .lines()
            .count(),
        2
    );
}

#[test]
fn bare_model_rejection_restores_the_last_working_model() {
    let mut server = Server::new(&[("OMP_MODEL", "glm-5.2-fp8")]);
    assert_eq!(status(&server.turn("text", json!({}))), "completed");
    let turn = server.turn("text", json!({"model": "missing-bare"}));
    assert_eq!(status(&turn), "failed");
    assert!(
        turn.last().unwrap()["params"]["turn"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unsupported model `missing-bare` for OMP: Model not found: missing-bare")
    );
    assert_eq!(status(&server.turn("text", json!({}))), "completed");
    let commands = server.commands();
    // A bare model never reaches open_session: the default provider's model
    // is selected in place, and only a working selection survives a rejection.
    assert!(
        commands
            .iter()
            .filter(|c| c["type"] == "open_session")
            .all(|c| c.get("modelId").is_none())
    );
    assert_eq!(
        commands
            .iter()
            .filter(|c| c["type"] == "set_model")
            .map(|c| c["modelId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["glm-5.2-fp8", "missing-bare", "glm-5.2-fp8"]
    );
}

#[test]
fn provider_switch_restarts_the_process_and_a_failed_switch_restores_both_halves() {
    let mut server = Server::new(&[("OMP_MODEL", "glm-5.2-fp8")]);
    assert_eq!(
        status(&server.turn("text", json!({"provider": "litellm"}))),
        "completed"
    );
    // Same model, different provider: the provider is part of process identity.
    assert_eq!(
        status(&server.turn("text", json!({"provider": "other"}))),
        "completed"
    );
    let turn = server.turn("text", json!({"provider": "broken"}));
    assert_eq!(status(&turn), "failed");
    assert!(
        turn.last().unwrap()["params"]["turn"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unsupported model `glm-5.2-fp8` for OMP: Model not found: broken")
    );
    assert_eq!(status(&server.turn("text", json!({}))), "completed");
    let commands = server.commands();
    assert_eq!(
        commands
            .iter()
            .filter(|c| c["type"] == "open_session")
            .map(|c| (
                c["provider"].as_str().unwrap().to_owned(),
                c["modelId"].as_str().unwrap().to_owned(),
            ))
            .collect::<Vec<_>>(),
        [
            ("litellm".to_owned(), "glm-5.2-fp8".to_owned()),
            ("other".to_owned(), "glm-5.2-fp8".to_owned()),
            ("broken".to_owned(), "glm-5.2-fp8".to_owned()),
            ("other".to_owned(), "glm-5.2-fp8".to_owned()),
        ]
    );
    assert_eq!(
        std::fs::read_to_string(server.dir.join("argv"))
            .unwrap()
            .lines()
            .count(),
        4
    );
}

#[test]
fn a_rejected_first_provider_falls_back_to_the_default_provider() {
    let mut server = Server::new(&[("OMP_MODEL", "glm-5.2-fp8")]);
    // No process ran before, so there is no working selection to go back to:
    // the rejected provider itself must not be the fallback.
    let turn = server.turn("text", json!({"provider": "broken"}));
    assert_eq!(status(&turn), "failed");
    let error = turn.last().unwrap()["params"]["turn"]["error"]["message"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(error.contains("Model not found: broken"), "{error}");
    assert_eq!(status(&server.turn("text", json!({}))), "completed");
    let commands = server.commands();
    let opened: Vec<_> = commands
        .iter()
        .filter(|command| command["type"] == "open_session")
        .collect();
    assert_eq!(opened.len(), 2, "{commands:#?}");
    assert_eq!(opened[0]["provider"], "broken");
    assert_eq!(opened[0]["modelId"], "glm-5.2-fp8");
    assert!(opened[1].get("provider").is_none(), "{:#?}", opened[1]);
    assert!(opened[1].get("modelId").is_none(), "{:#?}", opened[1]);
    assert_eq!(
        commands
            .iter()
            .find(|command| command["type"] == "set_model")
            .unwrap()["modelId"],
        "glm-5.2-fp8"
    );
}

#[test]
fn a_stale_settlement_does_not_retain_the_aborted_process() {
    let mut server = Server::new(&[("OMP_TEST_FAULT", "abort")]);
    server.timeout = Duration::from_secs(20);
    assert_eq!(
        status(&server.turn("trailing_settle", json!({}))),
        "completed"
    );
    server.user("slow", json!({}));
    server.until(|event| {
        event["method"] == "item/started" && event["params"]["item"]["type"] == "commandExecution"
    });
    server.send(json!({"type": "interrupt", "thread_key": KEY}));
    // The abort was rejected and the only settlement in flight belongs to the
    // previous turn, so the interrupted run must not be kept: the process is
    // replaced once the grace period expires.
    assert_eq!(status(&server.read_until("turn/completed")), "interrupted");
    assert_eq!(status(&server.turn("text", json!({}))), "completed");
    let commands = server.commands();
    assert!(
        commands.iter().any(|c| c["type"] == "abort"),
        "an interrupt must abort the turn in-band"
    );
    assert_eq!(
        std::fs::read_to_string(server.dir.join("argv"))
            .unwrap()
            .lines()
            .count(),
        2
    );
}

#[test]
fn a_rejected_steer_fails_the_turn_and_replaces_the_process() {
    let mut server = Server::mode(&[("OMP_TEST_FAULT", "steer")], "jsonrpc");
    server.send(
        json!({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "omp-steer", "version": "1"}}}),
    );
    server.until(|value| value["id"] == 1);
    server.send(json!({"id": 2, "method": "thread/start", "params": {"cwd": server.dir}}));
    let thread = server.until(|value| value["id"] == 2).last().unwrap()["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(
        json!({"id": 3, "method": "turn/start", "params": {"threadId": thread, "input": [
            {"type": "text", "text": "slow"},
        ]}}),
    );
    let mut values = server.until(|value| {
        value["method"] == "item/started" && value["params"]["item"]["type"] == "commandExecution"
    });
    let turn_id = values.last().unwrap()["params"]["turnId"].clone();
    server.send(json!({"id": 4, "method": "turn/steer", "params": {
        "threadId": thread, "expectedTurnId": turn_id,
        "input": [{"type": "text", "text": "keep going"}],
    }}));
    values.extend(server.read_until("turn/completed"));
    assert_eq!(status(&values), "failed");
    let error = values.last().unwrap()["params"]["turn"]["error"]["message"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(error.contains("omp steer: startup rejected"), "{error}");
    // The run could no longer be steered, so the next turn starts clean.
    server.send(
        json!({"id": 5, "method": "turn/start", "params": {"threadId": thread, "input": [
            {"type": "text", "text": "text"},
        ]}}),
    );
    let next = server.read_until("turn/completed");
    assert_eq!(status(&next), "completed", "{next:#?}");
    assert_eq!(
        std::fs::read_to_string(server.dir.join("argv"))
            .unwrap()
            .lines()
            .count(),
        2
    );
}

#[test]
fn an_unacknowledged_prompt_fails_the_turn_and_replaces_the_process() {
    let mut server = Server::new(&[]);
    server.timeout = Duration::from_secs(90);
    let turn = server.turn("no_ack", json!({}));
    assert_eq!(status(&turn), "failed");
    let error = turn.last().unwrap()["params"]["turn"]["error"]["message"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        error.contains("did not acknowledge the turn within 30s"),
        "{error}"
    );
    assert_eq!(status(&server.turn("text", json!({}))), "completed");
    assert_eq!(
        std::fs::read_to_string(server.dir.join("argv"))
            .unwrap()
            .lines()
            .count(),
        2
    );
}

#[test]
fn an_acknowledged_prompt_may_stay_quiet_past_the_ack_window() {
    let mut server = Server::new(&[]);
    server.timeout = Duration::from_secs(90);
    server.user("quiet_after_ack", json!({}));
    // Stay past the acknowledgement window: the prompt was accepted, so a
    // slow model must not be cut off.
    let deadline = Instant::now() + Duration::from_secs(31);
    let mut observed = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match server.stdout.recv_timeout(remaining) {
            Ok(value) => observed.push(value),
            Err(mpsc::RecvTimeoutError::Timeout) => break,
            Err(error) => panic!("turn output closed early: {error}"),
        }
    }
    assert!(
        observed
            .iter()
            .all(|value| value["method"] != "turn/completed"),
        "an acknowledged run was cut off: {observed:#?}"
    );
    // It is still running: an interrupt ends it normally.
    server.send(json!({"type": "interrupt", "thread_key": KEY}));
    assert_eq!(status(&server.read_until("turn/completed")), "interrupted");
}

#[test]
fn omp_stderr_is_redacted_and_only_its_size_is_reported() {
    // The child exits during startup, which ends its stderr and makes the
    // drain report the tail it withheld.
    let mut server = Server::new(&[
        ("OMP_TEST_FAULT", "eof"),
        ("OMP_TEST_STDERR", "sk-secret-marker"),
    ]);
    assert_eq!(status(&server.turn("text", json!({}))), "failed");
    let log = server.dir.join("server.stderr");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let text = std::fs::read_to_string(&log).unwrap_or_default();
        assert!(!text.contains("sk-secret-marker"), "secret leaked: {text}");
        if text.contains("stderr tail redacted") {
            assert!(
                text.contains("Omp stderr tail redacted ("),
                "unexpected report: {text}"
            );
            break;
        }
        assert!(Instant::now() < deadline, "no redaction report: {text}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn an_oversized_physical_line_fails_the_turn_and_replaces_the_process() {
    let mut server = Server::new(&[]);
    let turn = server.turn("oversized_line", json!({}));
    assert_eq!(status(&turn), "failed");
    let error = turn.last().unwrap()["params"]["turn"]["error"]["message"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(error.contains("stdout line exceeds"), "{error}");
    assert_eq!(status(&server.turn("text", json!({}))), "completed");
    assert_eq!(
        std::fs::read_to_string(server.dir.join("argv"))
            .unwrap()
            .lines()
            .count(),
        2
    );
}

#[test]
fn unsettled_background_output_stays_in_the_original_turn() {
    let mut server = Server::new(&[]);
    server.user("gated_background", json!({}));
    let mut turn = server.until(|event| {
        event["method"] == "item/completed" && event["params"]["item"]["type"] == "agentMessage"
    });
    server.paused();
    assert!(
        server
            .stdout
            .recv_timeout(Duration::from_millis(100))
            .is_err()
    );
    server.release();
    turn.extend(server.read_until("turn/completed"));
    assert_eq!(status(&turn), "completed");
    let messages = items(&turn, "item/completed", "agentMessage");
    assert_eq!(
        messages.iter().map(|m| &m["text"]).collect::<Vec<_>>(),
        [
            &json!("The command is running in the background."),
            &json!("The background command finished: e2e-background-ok.")
        ]
    );
    let id = &turn.last().unwrap()["params"]["turn"]["id"];
    for event in turn.iter().filter(|e| e["params"]["turnId"].is_string()) {
        assert_eq!(&event["params"]["turnId"], id);
    }
}

#[test]
fn startup_failures_never_send_a_prompt_and_next_turn_retries() {
    for fault in [
        "negotiate_protocol",
        "set_event_filter",
        "open_session",
        "set_cache_warming",
        "v1",
        "eof",
        "cancelled",
    ] {
        let mut server =
            Server::new(&[("OMP_TEST_FAULT", fault), ("OMP_MODEL", "custom/new-model")]);
        for extra in [json!({"model": "custom/requested"}), json!({})] {
            assert_eq!(status(&server.turn("text", extra)), "failed", "{fault}");
        }
        let commands = server.commands();
        assert!(!commands.iter().any(|c| c["type"] == "prompt"), "{fault}");
        // Only a rejected model sends the thread back to its last working model.
        assert!(
            commands
                .iter()
                .filter(|c| c["type"] == "open_session")
                .all(|c| c["modelId"] == "requested"),
            "{fault}"
        );
        assert_eq!(
            std::fs::read_to_string(server.dir.join("argv"))
                .unwrap()
                .lines()
                .count(),
            2,
            "{fault}"
        );
    }
}

#[test]
fn interrupt_and_model_switch_reopen_the_same_session() {
    let mut server = Server::new(&[]);
    server.user("slow", json!({}));
    server.until(|event| {
        event["method"] == "item/started" && event["params"]["item"]["type"] == "commandExecution"
    });
    server.send(json!({"type": "interrupt", "thread_key": KEY}));
    assert_eq!(status(&server.read_until("turn/completed")), "interrupted");
    // The abort settled in-band, so the turn's process and session stay live.
    assert_eq!(status(&server.turn("text", json!({}))), "completed");
    assert_eq!(
        status(&server.turn("text", json!({"model": "custom/switched"}))),
        "completed"
    );
    let commands = server.commands();
    assert!(
        commands.iter().any(|c| c["type"] == "abort"),
        "an interrupt must abort the turn in-band"
    );
    let opened: Vec<_> = commands
        .iter()
        .filter(|c| c["type"] == "open_session")
        .collect();
    assert_eq!(
        opened
            .iter()
            .map(|open| open.get("modelId"))
            .collect::<Vec<_>>(),
        [None, Some(&json!("switched"))]
    );
    for open in opened {
        assert_eq!(
            open["sessionDir"],
            server
                .dir
                .join("sessions")
                .join(session_dir(KEY))
                .to_string_lossy()
                .as_ref()
        );
    }
    assert_eq!(
        std::fs::read_to_string(server.dir.join("argv"))
            .unwrap()
            .lines()
            .count(),
        2
    );
}

#[test]
fn unavailable_model_restores_the_last_working_model() {
    let mut server = Server::new(&[("OMP_MODEL", "custom/default")]);
    assert_eq!(
        status(&server.turn("text", json!({"model": "custom/working"}))),
        "completed"
    );
    let turn = server.turn("text", json!({"model": "custom/missing"}));
    assert_eq!(status(&turn), "failed");
    assert!(
        turn.last().unwrap()["params"]["turn"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains(
                "unsupported model `custom/missing` for OMP: Model not found: custom/missing"
            )
    );
    assert_eq!(status(&server.turn("text", json!({}))), "completed");
    let commands = server.commands();
    assert_eq!(
        commands
            .iter()
            .filter(|c| c["type"] == "open_session")
            .map(|c| c["modelId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["working", "missing", "working"]
    );
}

#[test]
fn unrestorable_saved_model_fails_until_a_turn_names_a_model() {
    let mut server = Server::new(&[("OMP_TEST_FAULT", "restore_model")]);
    let turn = server.turn("text", json!({}));
    assert_eq!(status(&turn), "failed");
    assert!(
        turn.last().unwrap()["params"]["turn"]["error"]["message"]
            .as_str()
            .unwrap()
            .ends_with("omp open_session: Could not restore model custom/saved")
    );
    assert_eq!(
        status(&server.turn("text", json!({"model": "custom/named"}))),
        "completed"
    );
}

#[test]
fn bare_model_uses_the_blocks_provider_or_the_sessions_own() {
    // A provider beside the model goes into open_session with the turn's model.
    let mut server = Server::new(&[]);
    assert_eq!(
        status(&server.turn(
            "text",
            json!({"model": "glm-5.2-fp8", "provider": "custom"})
        )),
        "completed"
    );
    let commands = server.commands();
    let open = commands
        .iter()
        .find(|command| command["type"] == "open_session")
        .unwrap();
    assert_eq!(open["provider"], "custom");
    assert_eq!(open["modelId"], "glm-5.2-fp8");
    assert!(
        !commands
            .iter()
            .any(|command| command["type"] == "set_model"),
        "{commands:#?}"
    );
    server.close();

    // Without one, the resumed session's own provider is kept.
    let mut server = Server::new(&[("OMP_MODEL", "glm-5.2-fp8")]);
    assert_eq!(status(&server.turn("text", json!({}))), "completed");
    let commands = server.commands();
    let open = commands
        .iter()
        .find(|command| command["type"] == "open_session")
        .unwrap();
    assert!(open.get("provider").is_none(), "{open:#?}");
    assert!(open.get("modelId").is_none(), "{open:#?}");
    let set_model = commands
        .iter()
        .find(|command| command["type"] == "set_model")
        .unwrap();
    assert_eq!(set_model["provider"], "litellm");
    assert_eq!(set_model["modelId"], "glm-5.2-fp8");
    let sequence = kinds(&commands);
    let position = |kind: &str| sequence.iter().position(|entry| *entry == kind).unwrap();
    assert!(position("open_session") < position("get_state"));
    assert!(position("get_state") < position("set_model"));
    assert!(position("set_model") < position("set_cache_warming"));
}

#[test]
fn jsonrpc_preserves_image_paths_when_attachments_cannot_be_inlined() {
    let mut server = Server::mode(&[], "jsonrpc");
    server.send(json!({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "omp-test", "version": "1"}}}));
    server.until(|v| v["id"] == 1);
    server.send(json!({"id": 2, "method": "thread/start", "params": {"cwd": server.dir}}));
    let response = server.until(|v| v["id"] == 2);
    let thread = response.last().unwrap()["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let missing = server.dir.join("missing.png");
    let unsupported = server.dir.join("image.svg");
    let directory = server.dir.join("directory.png");
    std::fs::write(&unsupported, "<svg/>").unwrap();
    std::fs::create_dir(&directory).unwrap();
    server.send(json!({"id": 3, "method": "turn/start", "params": {"threadId": thread, "input": [
        {"type": "text", "text": "text"}, {"type": "localImage", "path": missing}, {"type": "localImage", "path": unsupported}, {"type": "localImage", "path": directory}, {"type": "image", "url": "https://example.invalid/image.png"}, {"type": "image", "url": "data:image/gif;base64,R0lGODlh"},
    ]}}));
    let turn = server.read_until("turn/completed");
    assert_eq!(status(&turn), "completed", "{turn:#?}");
    assert_eq!(
        items(&turn, "item/completed", "agentMessage")[0]["text"],
        "Hello from the loopback mock."
    );
    let commands = server.commands();
    let prompt = commands.iter().find(|c| c["type"] == "prompt").unwrap();
    assert!(
        prompt["message"]
            .as_str()
            .unwrap()
            .contains(missing.to_str().unwrap())
    );
    assert!(
        prompt["message"]
            .as_str()
            .unwrap()
            .contains("https://example.invalid/image.png")
    );
    assert_eq!(
        prompt["images"],
        json!([{"type": "image", "data": "R0lGODlh", "mimeType": "image/gif"}])
    );
    assert_eq!(
        commands
            .iter()
            .find(|c| c["type"] == "open_session")
            .unwrap()["sessionDir"],
        server
            .dir
            .join("sessions")
            .join(session_dir(&thread))
            .to_string_lossy()
            .as_ref()
    );
}

#[test]
#[ignore = "requires ANTHROPIC_API_KEY and real OMP; makes provider calls"]
fn real_omp_streaming_steer_and_resume() {
    fn resume(server: &mut Server, thread: &str, model: &str) {
        server.send(json!({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "real-omp-test", "version": "1"}}}));
        assert!(server.until(|v| v["id"] == 1).last().unwrap()["error"].is_null());
        server.send(json!({"id": 2, "method": "thread/resume", "params": {"threadId": thread, "model": model}}));
        assert_eq!(
            server.until(|v| v["id"] == 2).last().unwrap()["result"]["thread"]["id"],
            thread
        );
    }
    fn final_text(values: &[Value]) -> String {
        items(values, "item/completed", "agentMessage")
            .iter()
            .filter_map(|item| item["text"].as_str())
            .collect()
    }
    assert!(
        std::env::var("ANTHROPIC_API_KEY").is_ok_and(|key| !key.is_empty()),
        "set ANTHROPIC_API_KEY before running real OMP tests"
    );
    let binary = std::env::var_os("OMP_BIN").unwrap_or_else(|| "omp".into());
    let version = Command::new(&binary)
        .arg("--version")
        .output()
        .expect("real omp on PATH or OMP_BIN");
    assert!(version.status.success(), "OMP --version failed");
    let model = std::env::var("CENTAUR_REAL_OMP_MODEL")
        .unwrap_or_else(|_| "anthropic/claude-sonnet-5".to_string());
    let dir = std::env::temp_dir().join(format!("real-omp-stdio-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let thread = format!("real-omp-{}", Uuid::new_v4().simple());
    let codeword = format!("OMP_MEMORY_{}", Uuid::new_v4().simple());
    let acknowledgement = format!("STEER_{}", Uuid::new_v4().simple());
    let mut server = Server::with_binary(
        dir.clone(),
        "jsonrpc",
        &binary,
        &[("OMP_BIN", binary.to_str().unwrap())],
    );
    server.timeout = Duration::from_secs(300);
    resume(&mut server, &thread, &model);
    server.send(json!({"id": 3, "method": "turn/start", "params": {"threadId": thread, "input": [{"type": "text", "text": format!("Remember the codeword {codeword} for later. First run exactly `sleep 5` with bash. Then produce 300 numbered lines. If an update arrives, follow it.")}]}}));
    let mut values = server.until(|value| {
        value["method"] == "turn/completed"
            || (value["method"] == "item/started"
                && value["params"]["item"]["type"] == "commandExecution")
    });
    assert!(
        !values
            .iter()
            .any(|value| value["method"] == "turn/completed"),
        "turn ended before the tool started: {values:#?}"
    );
    let turn_id = values.last().unwrap()["params"]["turnId"].clone();
    server.send(json!({"id": 4, "method": "turn/steer", "params": {"threadId": thread, "expectedTurnId": turn_id, "clientUserMessageId": "real-omp-steer", "input": [{"type": "text", "text": format!("Stop the numbered listing. Remember the codeword {codeword}. Reply exactly {acknowledgement} and nothing else.")}]}}));
    values.extend(server.read_until("turn/completed"));
    assert_eq!(status(&values), "completed");
    assert_eq!(values.last().unwrap()["params"]["turn"]["id"], turn_id);
    assert_eq!(
        values.iter().find(|value| value["id"] == 4).unwrap()["result"]["turnId"],
        turn_id
    );
    assert!(
        final_text(&values).contains(&acknowledgement),
        "OMP did not apply the steering update"
    );
    assert!(
        values.last().unwrap()["params"]["turn"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["clientId"] == "real-omp-steer")
    );

    // Preserve the session directory, not the process's conversation state.
    let children = Command::new("pgrep")
        .args(["-P", &server.child.id().to_string()])
        .output()
        .expect("pgrep for the real OMP child");
    assert!(
        children.status.success(),
        "OMP child missing after the turn"
    );
    let children = String::from_utf8(children.stdout).unwrap();
    let pids: Vec<&str> = children.split_whitespace().collect();
    assert_eq!(pids.len(), 1, "expected one direct OMP child: {pids:?}");
    assert!(
        Command::new("kill")
            .arg("-KILL")
            .args(&pids)
            .status()
            .unwrap()
            .success()
    );
    server.child.kill().unwrap();
    server.child.wait().unwrap();

    let mut resumed = Server::with_binary(
        dir,
        "jsonrpc",
        &binary,
        &[("OMP_BIN", binary.to_str().unwrap())],
    );
    resumed.timeout = Duration::from_secs(300);
    resume(&mut resumed, &thread, &model);
    resumed.send(json!({"id": 3, "method": "turn/start", "params": {"threadId": thread, "effort": "none", "input": [{"type": "text", "text": "Without using tools, what exact codeword did I ask you to remember earlier? Reply with only that codeword."}]}}));
    let recalled = resumed.read_until("turn/completed");
    assert_eq!(status(&recalled), "completed");
    assert_eq!(final_text(&recalled).trim(), codeword);
    assert!(items(&recalled, "item/completed", "reasoning").is_empty());
    resumed.send(json!({"id": 4, "method": "turn/start", "params": {"threadId": thread, "input": [{"type": "text", "text": "Without using tools, what is 17 multiplied by 23? Reply with only the number."}]}}));
    let default_level = resumed.read_until("turn/completed");
    assert_eq!(status(&default_level), "completed");
    assert!(final_text(&default_level).contains("391"));
    eprintln!(
        "real {}: steer acknowledged in final items; native resume recalled the codeword with thinking off",
        String::from_utf8_lossy(&version.stdout).trim()
    );
}
