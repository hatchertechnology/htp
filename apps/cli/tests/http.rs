use std::{
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    process::{Command, Output},
    thread,
    time::Duration,
};

fn run_cli(status: &str, body: &str) -> Output {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(&stream);
        let mut line = String::new();
        loop {
            line.clear();
            assert!(reader.read_line(&mut line).unwrap() > 0);
            if line == "\r\n" {
                break;
            }
        }
        stream.write_all(response.as_bytes()).unwrap();
    });

    let output = Command::new(env!("CARGO_BIN_EXE_htp-cli"))
        .args(["--url", &url])
        .env("NO_PROXY", "127.0.0.1")
        .output()
        .unwrap();
    server.join().unwrap();
    output
}

#[test]
fn prints_the_message_received_from_the_api() {
    let output = run_cli("200 OK", r#"{"message":"message from test server"}"#);
    assert!(output.status.success());
    assert_eq!(output.stdout, b"message from test server\n");
    assert!(output.stderr.is_empty());
}

#[test]
fn reports_http_errors() {
    let output = run_cli("500 Internal Server Error", r#"{"message":"failure"}"#);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("500"));
}

#[test]
fn rejects_responses_missing_the_shared_message_field() {
    let output = run_cli("200 OK", r#"{"unexpected":"value"}"#);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Failed to fetch API message"));
}
