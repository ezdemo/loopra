use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::{
    aead, agreement, digest, hkdf,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

const LABEL: &str = "loopra-relay-e2e/v1";

pub fn encode(raw: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(raw)
}
pub fn decode(raw: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| "中继数据编码无效".into())
}
struct Length(usize);
impl hkdf::KeyType for Length {
    fn len(&self) -> usize {
        self.0
    }
}
fn derive(ikm: &[u8], salt: &[u8], info: &[u8], length: usize) -> Result<Vec<u8>, String> {
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, salt).extract(ikm);
    let parts = [info];
    let key = prk
        .expand(&parts, Length(length))
        .map_err(|_| "密钥派生失败")?;
    let mut output = vec![0; length];
    key.fill(&mut output).map_err(|_| "密钥派生失败")?;
    Ok(output)
}
pub fn routing_id(code: &str) -> Result<String, String> {
    Ok(encode(&derive(
        code.as_bytes(),
        format!("{LABEL}/routing").as_bytes(),
        &[],
        16,
    )?))
}
pub fn origin(code: &str) -> String {
    let hash = digest::digest(&digest::SHA256, code.as_bytes());
    let host: String = hash.as_ref()[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("https://{host}.loopra.invalid")
}

#[derive(Serialize, Deserialize)]
pub struct Hello {
    pub t: String,
    #[serde(default)]
    pub epk: String,
    #[serde(default)]
    pub n: String,
    #[serde(default)]
    pub cr: String,
    #[serde(default)]
    pub ci: String,
    #[serde(default)]
    pub bin: u8,
}
pub struct Handshake {
    private: agreement::EphemeralPrivateKey,
    public: Vec<u8>,
    nonce: [u8; 16],
}
impl Handshake {
    pub fn new() -> Result<(Self, Hello), String> {
        let rng = SystemRandom::new();
        let private = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng)
            .map_err(|_| "生成握手密钥失败")?;
        let public = private
            .compute_public_key()
            .map_err(|_| "生成握手公钥失败")?
            .as_ref()
            .to_vec();
        let mut nonce = [0; 16];
        rng.fill(&mut nonce).map_err(|_| "生成握手随机数失败")?;
        let hello = Hello {
            t: "hi".into(),
            epk: encode(&public),
            n: encode(&nonce),
            cr: String::new(),
            ci: String::new(),
            bin: 0,
        };
        Ok((
            Self {
                private,
                public,
                nonce,
            },
            hello,
        ))
    }
    pub fn finish(self, code: &str, hello: Hello) -> Result<(Session, serde_json::Value), String> {
        if hello.t != "hi" || hello.bin != 0 {
            return Err("桌面加密协议不兼容".into());
        }
        let public = decode(&hello.epk)?;
        let nonce = decode(&hello.n)?;
        if public.len() != 65 || public[0] != 4 || nonce.len() != 16 {
            return Err("桌面握手数据无效".into());
        }
        let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, &public);
        let shared = agreement::agree_ephemeral(self.private, &peer, |shared| shared.to_vec())
            .map_err(|_| "桌面握手公钥无效")?;
        let transcript = [LABEL.as_bytes(), &self.public, &public, &self.nonce, &nonce].concat();
        let hash = digest::digest(&digest::SHA256, &transcript);
        let key = |label: &str| {
            derive(
                &shared,
                code.as_bytes(),
                &[label.as_bytes(), hash.as_ref()].concat(),
                32,
            )
        };
        let confirmation = key("confirm-r|")?;
        if !bool::from(confirmation.ct_eq(&decode(&hello.cr)?)) {
            return Err("桌面身份验证失败，请扫描当前配对码".into());
        }
        let cipher = |raw: Vec<u8>| {
            aead::UnboundKey::new(&aead::AES_256_GCM, &raw)
                .map(aead::LessSafeKey::new)
                .map_err(|_| "创建加密会话失败".to_string())
        };
        Ok((
            Session {
                send: cipher(key("c2s|")?)?,
                receive: cipher(key("s2c|")?)?,
                send_counter: Some(0),
                receive_counter: Some(0),
            },
            serde_json::json!({"t":"ok", "ci":encode(&key("confirm-i|")?)}),
        ))
    }
}
pub struct Session {
    send: aead::LessSafeKey,
    receive: aead::LessSafeKey,
    send_counter: Option<u64>,
    receive_counter: Option<u64>,
}
fn iv(counter: Option<u64>) -> Result<[u8; 12], String> {
    let mut iv = [0; 12];
    iv[4..].copy_from_slice(&counter.ok_or("加密会话已过期，请重新连接")?.to_be_bytes());
    Ok(iv)
}
impl Session {
    pub fn seal(&mut self, frame: &serde_json::Value) -> Result<Vec<u8>, String> {
        let iv = iv(self.send_counter)?;
        let mut raw = serde_json::to_vec(frame).map_err(|_| "请求编码失败")?;
        self.send
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(iv),
                aead::Aad::empty(),
                &mut raw,
            )
            .map_err(|_| "请求加密失败")?;
        self.send_counter = self.send_counter.and_then(|n| n.checked_add(1));
        Ok([iv.as_slice(), &raw].concat())
    }
    pub fn open(&mut self, wire: &[u8]) -> Result<serde_json::Value, String> {
        if wire.len() < 28 || wire.len() > 8 << 20 {
            return Err("加密帧无效".into());
        }
        let iv = iv(self.receive_counter)?;
        if wire[..12] != iv {
            return Err("加密帧顺序无效".into());
        }
        let mut raw = wire[12..].to_vec();
        let raw = self
            .receive
            .open_in_place(
                aead::Nonce::assume_unique_for_key(iv),
                aead::Aad::empty(),
                &mut raw,
            )
            .map_err(|_| "加密帧认证失败")?;
        let value = serde_json::from_slice(raw).map_err(|_| "隧道响应无效")?;
        self.receive_counter = self.receive_counter.and_then(|n| n.checked_add(1));
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sessions() -> (Session, Session) {
        let cipher = |byte| {
            aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &[byte; 32]).unwrap())
        };
        (
            Session {
                send: cipher(1),
                receive: cipher(2),
                send_counter: Some(0),
                receive_counter: Some(0),
            },
            Session {
                send: cipher(2),
                receive: cipher(1),
                send_counter: Some(0),
                receive_counter: Some(0),
            },
        )
    }
    #[test]
    fn rejects_replay_tampering_and_counter_overflow() {
        let (mut client, mut server) = sessions();
        let value = serde_json::json!({"t":"hreq", "id":"one"});
        let wire = client.seal(&value).unwrap();
        let mut bad = wire.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(server.open(&bad).is_err());
        assert_eq!(server.open(&wire).unwrap(), value);
        assert!(server.open(&wire).is_err());
        client.send_counter = Some(u64::MAX);
        server.receive_counter = Some(u64::MAX);
        assert_eq!(server.open(&client.seal(&value).unwrap()).unwrap(), value);
        assert!(client.seal(&value).is_err());
        assert!(server.open(&wire).is_err());
    }
    #[test]
    fn rejects_invalid_handshake_and_noncanonical_base64() {
        let (handshake, hello) = Handshake::new().unwrap();
        assert!(handshake.finish("code", hello).is_err());
        assert!(decode("AB").is_err());
        assert!(decode("a=").is_err());
    }
}
