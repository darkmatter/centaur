use bytes::Bytes;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReadOptions {
    pub stream: OutputStream,
    pub after_offset: Option<u64>,
    pub max_bytes: usize,
    pub timeout_ms: Option<u64>,
}

impl ReadOptions {
    pub fn stdout(max_bytes: usize) -> Self {
        Self {
            stream: OutputStream::Stdout,
            after_offset: None,
            max_bytes,
            timeout_ms: None,
        }
    }

    pub fn stderr(max_bytes: usize) -> Self {
        Self {
            stream: OutputStream::Stderr,
            after_offset: None,
            max_bytes,
            timeout_ms: None,
        }
    }

    pub fn after_offset(mut self, offset: u64) -> Self {
        self.after_offset = Some(offset);
        self
    }

    pub fn timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.timeout_ms = Some(timeout_ms);
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ReadResult {
    Bytes {
        bytes: Bytes,
        stream: OutputStream,
        start_offset: Option<u64>,
        next_offset: Option<u64>,
    },
    TimedOut,
    Eof,
}

impl ReadResult {
    pub fn stdout(bytes: impl Into<Bytes>) -> Self {
        Self::Bytes {
            bytes: bytes.into(),
            stream: OutputStream::Stdout,
            start_offset: None,
            next_offset: None,
        }
    }

    pub fn stderr(bytes: impl Into<Bytes>) -> Self {
        Self::Bytes {
            bytes: bytes.into(),
            stream: OutputStream::Stderr,
            start_offset: None,
            next_offset: None,
        }
    }

    pub fn with_offsets(self, start_offset: u64, next_offset: u64) -> Self {
        match self {
            Self::Bytes { bytes, stream, .. } => Self::Bytes {
                bytes,
                stream,
                start_offset: Some(start_offset),
                next_offset: Some(next_offset),
            },
            other => other,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WriteAck {
    pub bytes_written: usize,
}

impl WriteAck {
    pub fn new(bytes_written: usize) -> Self {
        Self { bytes_written }
    }
}
