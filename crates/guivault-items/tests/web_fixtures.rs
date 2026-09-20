//! Ce que l'interface web écrit se relit ici, sans perte. `web-items.json`
//! est produit par `GUIVAULT_WRITE_VECTORS=1 npx vitest run` dans `web/`.
use guivault_items::*;
use serde_json::Value;

#[test]
fn web_items_parse_and_roundtrip() {
    let raw = include_str!("web-items.json");
    let values: Vec<Value> = serde_json::from_str(raw).unwrap();
    assert_eq!(values.len(), 4);
    for v in &values {
        let item = SecretItem::from_json(v.to_string().as_bytes()).unwrap();
        assert_eq!(item.item_type(), v["kind"].as_str().unwrap());
        assert_eq!(item.id().to_string(), v[v["kind"].as_str().unwrap()]["id"].as_str().unwrap());
        // Re-sérialisé puis relu : identique, et rien de perdu par rapport
        // au JSON d'origine (chaque clé du web est encore là).
        let again: Value = serde_json::from_str(&item.to_json().unwrap()).unwrap();
        let kind = v["kind"].as_str().unwrap();
        for (key, val) in v[kind].as_object().unwrap() {
            assert_eq!(&again[kind][key], val, "{kind}.{key}");
        }
    }
    let login = SecretItem::from_json(values[0].to_string().as_bytes()).unwrap();
    let SecretItem::Login { login } = login else { panic!() };
    assert_eq!(login.username, "alice");
    assert_eq!(login.uris[0].uri, "https://github.com");
    assert_eq!(login.passkeys[0].rp_id, "github.com");
    assert!(login.passkeys[0].discoverable);
    assert_eq!(login.password_history[0].password, "old");
    assert_eq!(login.base.fields.as_ref().unwrap()[0].r#type, FieldType::Hidden);
    assert_eq!(login.base.favorite, Some(true));
}
