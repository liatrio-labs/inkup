//! Reading fields of the JSON the Host stores verbatim: timeline events and Change Items. The Host checks only an
//! event's id, type and `t` on the way in (the Client and the Host update independently), so every other field it
//! reads back is read by name, and a wrong name reads as nothing: `voice_command` was once read by `name`, not
//! `command`. Every such read goes through [`Fields`], and while [`record`] runs, each read is logged with its path
//! and the JSON type it wanted and found. The contract test (crates/server/src/contract.rs) feeds every generated
//! event fixture through the readers and checks each logged path against the timeline schema.

use std::cell::RefCell;

use serde_json::Value;

/// What a reader wanted at a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Want {
    Str,
    Int,
    Array,
    Object,
    /// Any value: copied through as it is, or checked for null.
    Any,
}

/// The JSON type found at a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Found {
    Missing,
    Null,
    Bool,
    Int,
    Float,
    Str,
    Array,
    Object,
}

impl Found {
    fn of(value: Option<&Value>) -> Self {
        match value {
            None => Self::Missing,
            Some(Value::Null) => Self::Null,
            Some(Value::Bool(_)) => Self::Bool,
            Some(Value::Number(n)) if n.is_i64() || n.is_u64() => Self::Int,
            Some(Value::Number(_)) => Self::Float,
            Some(Value::String(_)) => Self::Str,
            Some(Value::Array(_)) => Self::Array,
            Some(Value::Object(_)) => Self::Object,
        }
    }

    /// A value of the kind `want` asked for, not just any value.
    pub fn satisfies(self, want: Want) -> bool {
        match want {
            Want::Str => self == Self::Str,
            Want::Int => self == Self::Int,
            Want::Array => self == Self::Array,
            Want::Object => self == Self::Object,
            Want::Any => !matches!(self, Self::Missing | Self::Null),
        }
    }
}

/// One read: `annotation:candidates[].name` (the root, then the fields, `[]` for an array item).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Read {
    pub path: String,
    pub want: Want,
    pub found: Found,
}

thread_local! {
    static READS: RefCell<Option<Vec<Read>>> = const { RefCell::new(None) };
}

fn recording() -> bool {
    READS.with(|reads| reads.borrow().is_some())
}

/// Runs `f` and returns what it read through [`Fields`] on this thread.
pub fn record<T>(f: impl FnOnce() -> T) -> (T, Vec<Read>) {
    READS.with(|reads| *reads.borrow_mut() = Some(Vec::new()));
    let out = f();
    let reads = READS.with(|reads| reads.borrow_mut().take()).unwrap_or_default();
    (out, reads)
}

static NULL: Value = Value::Null;

/// A stored event or Change Item, or a part of one, read field by field.
#[derive(Debug, Clone)]
pub struct Fields<'a> {
    value: Option<&'a Value>,
    /// Built only while recording.
    path: Option<String>,
}

impl<'a> Fields<'a> {
    /// A timeline event: its paths start with its type (`annotation:`).
    pub fn event(value: &'a Value) -> Self {
        let path = recording().then(|| format!("{}:", value.get("type").and_then(Value::as_str).unwrap_or("?")));
        Self { value: Some(value), path }
    }

    /// A Change Item: its paths start with `item:`.
    pub fn item(value: &'a Value) -> Self {
        Self { value: Some(value), path: recording().then(|| "item:".to_owned()) }
    }

    fn child_path(&self, key: &str) -> Option<String> {
        self.path.as_ref().map(|p| if p.ends_with(':') { format!("{p}{key}") } else { format!("{p}.{key}") })
    }

    fn log(&self, key: &str, want: Want) -> Option<&'a Value> {
        let value = self.value.and_then(|v| v.get(key));
        if let Some(path) = self.child_path(key) {
            READS.with(|reads| {
                if let Some(reads) = reads.borrow_mut().as_mut() {
                    reads.push(Read { path, want, found: Found::of(value) });
                }
            });
        }
        value
    }

    /// An object field, to read further into.
    pub fn get(&self, key: &str) -> Fields<'a> {
        let value = self.log(key, Want::Object);
        Fields { value, path: self.child_path(key) }
    }

    pub fn str(&self, key: &str) -> Option<&'a str> {
        self.log(key, Want::Str).and_then(Value::as_str)
    }

    /// A string field, empty when absent.
    pub fn text(&self, key: &str) -> String {
        self.str(key).unwrap_or_default().to_owned()
    }

    pub fn i64(&self, key: &str) -> Option<i64> {
        self.log(key, Want::Int).and_then(Value::as_i64)
    }

    pub fn u64(&self, key: &str) -> Option<u64> {
        self.log(key, Want::Int).and_then(Value::as_u64)
    }

    /// The field as it is (null when absent), to copy through or compare.
    pub fn raw(&self, key: &str) -> &'a Value {
        self.log(key, Want::Any).unwrap_or(&NULL)
    }

    /// Absent or null.
    pub fn is_null(&self, key: &str) -> bool {
        self.raw(key).is_null()
    }

    /// The items of an array field (none when it is not an array).
    pub fn array(&self, key: &str) -> Vec<Fields<'a>> {
        let path = self.child_path(key).map(|p| format!("{p}[]"));
        self.log(key, Want::Array)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|value| Fields { value: Some(value), path: path.clone() })
            .collect()
    }

    /// Item `index` of an array field.
    pub fn at(&self, key: &str, index: Option<u64>) -> Option<Fields<'a>> {
        let items = self.array(key);
        index.and_then(|i| usize::try_from(i).ok()).and_then(|i| items.into_iter().nth(i))
    }

    /// Present at all: an array item or an object field that was found.
    pub fn exists(&self) -> bool {
        self.value.is_some_and(|v| !v.is_null())
    }

    /// The value this reads, if any.
    pub fn value(&self) -> Option<&'a Value> {
        self.value.filter(|v| !v.is_null())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_are_logged_with_their_path_while_recording() {
        let event = json!({ "type": "annotation", "pick": 0, "candidates": [{ "name": "Go" }], "anchor": {} });
        let (name, reads) = record(|| {
            let e = Fields::event(&event);
            let picked = e.at("candidates", e.u64("pick"));
            let _ = e.get("anchor").str("exact");
            picked.and_then(|c| c.str("name")).map(str::to_owned)
        });
        assert_eq!(name.as_deref(), Some("Go"));
        let paths: Vec<_> = reads.iter().map(|r| (r.path.as_str(), r.want, r.found)).collect();
        assert_eq!(
            paths,
            [
                ("annotation:pick", Want::Int, Found::Int),
                ("annotation:candidates", Want::Array, Found::Array),
                ("annotation:anchor", Want::Object, Found::Object),
                ("annotation:anchor.exact", Want::Str, Found::Missing),
                ("annotation:candidates[].name", Want::Str, Found::Str),
            ]
        );
        // Nothing is logged outside `record`.
        assert_eq!(Fields::event(&event).str("pick"), None);
        assert!(record(|| ()).1.is_empty());
    }
}
