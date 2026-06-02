use std::collections::BTreeMap;

pub(super) fn parse_label_selector_arg(value: &str) -> Result<BTreeMap<String, String>, String> {
    let mut labels = BTreeMap::new();
    for item in value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        let Some((key, value)) = item.split_once('=') else {
            return Err(format!("label selector item {item:?} must be key=value"));
        };
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            return Err(format!("label selector item {item:?} must be key=value"));
        }
        labels.insert(key.to_owned(), value.to_owned());
    }
    Ok(labels)
}
