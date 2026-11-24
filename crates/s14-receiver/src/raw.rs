use crate::{MAX_DEPTH, MAX_POLICY_BYTES, MAX_STRING_BYTES};
use std::{collections::HashSet, time::Instant};

pub(crate) fn check(input: &str, deadline: Instant) -> Result<(), String> {
    let mut scanner = Scanner {
        input,
        at: 0,
        work: 0,
        deadline,
    };
    scanner.value(0, &mut Vec::new())?;
    scanner.space();
    if scanner.at != input.len() {
        return Err("trailing bytes".into());
    }
    Ok(())
}
struct Scanner<'a> {
    input: &'a str,
    at: usize,
    work: usize,
    deadline: Instant,
}
impl Scanner<'_> {
    fn tick(&mut self) -> Result<(), String> {
        self.work += 1;
        if self.work.is_multiple_of(1024) && Instant::now() >= self.deadline {
            return Err("inspection deadline".into());
        }
        Ok(())
    }
    fn byte(&self) -> Option<u8> {
        self.input.as_bytes().get(self.at).copied()
    }
    fn space(&mut self) {
        while self.byte().is_some_and(|b| b" \n\r\t".contains(&b)) {
            self.at += 1;
        }
    }
    fn string(&mut self, policy: bool) -> Result<String, String> {
        let start = self.at;
        self.at += 1;
        while let Some(b) = self.byte() {
            self.tick()?;
            self.at += 1;
            if b == b'\\' {
                self.at += 1;
            } else if b == b'"' {
                let decoded: String =
                    serde_json::from_str(&self.input[start..self.at]).map_err(|e| e.to_string())?;
                let cap = if policy {
                    MAX_POLICY_BYTES
                } else {
                    MAX_STRING_BYTES
                };
                if decoded.contains('\0') || decoded.len() > cap {
                    return Err("string bound/NUL".into());
                }
                return Ok(decoded);
            }
        }
        Err("unterminated string".into())
    }
    fn value(&mut self, depth: usize, path: &mut Vec<String>) -> Result<(), String> {
        self.tick()?;
        self.space();
        match self.byte() {
            Some(b'"') => {
                self.string(path == &["policy_guidance", "candidate", "policy_canonical_json"])?;
            }
            Some(open @ (b'{' | b'[')) => {
                if depth >= MAX_DEPTH {
                    return Err("container depth".into());
                }
                self.at += 1;
                let object = open == b'{';
                let close = if object { b'}' } else { b']' };
                let mut keys = HashSet::new();
                self.space();
                if self.byte() == Some(close) {
                    self.at += 1;
                    return Ok(());
                }
                loop {
                    self.space();
                    let key = if object {
                        if self.byte() != Some(b'"') {
                            return Err("object key".into());
                        }
                        let k = self.string(false)?;
                        if !keys.insert(k.clone()) {
                            return Err("duplicate decoded key".into());
                        }
                        self.space();
                        if self.byte() != Some(b':') {
                            return Err("colon".into());
                        }
                        self.at += 1;
                        k
                    } else {
                        "[]".into()
                    };
                    path.push(key);
                    self.value(depth + 1, path)?;
                    path.pop();
                    self.space();
                    if self.byte() == Some(close) {
                        self.at += 1;
                        break;
                    }
                    if self.byte() != Some(b',') {
                        return Err("comma".into());
                    }
                    self.at += 1;
                }
            }
            Some(b't') => self.literal(b"true")?,
            Some(b'f') => self.literal(b"false")?,
            Some(b'n') => self.literal(b"null")?,
            Some(b'-' | b'0'..=b'9') => self.number()?,
            _ => return Err("JSON value".into()),
        }
        Ok(())
    }
    fn literal(&mut self, literal: &[u8]) -> Result<(), String> {
        if self.input.as_bytes().get(self.at..self.at + literal.len()) != Some(literal) {
            return Err("literal".into());
        }
        self.at += literal.len();
        Ok(())
    }
    fn digits(&mut self) -> Result<(), String> {
        let start = self.at;
        while self.byte().is_some_and(|b| b.is_ascii_digit()) {
            self.tick()?;
            self.at += 1;
        }
        if self.at == start {
            return Err("number digit".into());
        }
        Ok(())
    }
    // Check JSON grammar without coercing opaque-source numbers into f64/u64.
    fn number(&mut self) -> Result<(), String> {
        if self.byte() == Some(b'-') {
            self.at += 1;
        }
        if self.byte() == Some(b'0') {
            self.at += 1;
        } else {
            self.digits()?;
        }
        if self.byte() == Some(b'.') {
            self.at += 1;
            self.digits()?;
        }
        if matches!(self.byte(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.byte(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            self.digits()?;
        }
        Ok(())
    }
}
