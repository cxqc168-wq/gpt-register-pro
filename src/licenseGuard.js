const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const SERVER_URL = process.env.LICENSE_GUARD_SERVER_URL || 'http://64.90.20.244:8443';
const EXPECTED_CODE = 'CXQC0168';

const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAntf1Zq3V+o9DIu4sLfI8
rHxsc4weH17dIUm/UUIsGjXSipUN1/XqKj5EB2PGGYwu5gWlDoDWR7IZUmbcX6p5
NmmL8AqccBQbAzv/pyoKjYuh1T+nb0SzXHKxQdRPu3WdVWQMkdiGaYDu4XjxBoBN
JM3qvjMs8QCv3cQIbMeYbukFoUpPo0nX7JphZb5DqJw33I+mgqcxb5++ekXbR6H4
a6An/dfEnkf72ObvkUb6N1uJQGkLvpJBCWVTZw+DNnCO/DF52eob0z0iIKazS8Eb
/5y7hfk1ixnh4+YcvvwqNlc3JYv/rce9xvQWi8j5uxnEX7PBZkYwrc22+ZaouBM2
fQIDAQAB
-----END PUBLIC KEY-----`;

const STATUS = {
  OK: 'ok',
  MISSING: 'missing',
  CORRUPTED: 'corrupted',
  SIGNATURE_INVALID: 'signature_invalid',
  MACHINE_MISMATCH: 'machine_mismatch',
  EXPIRED: 'expired',
  CLOCK_ROLLBACK: 'clock_rollback',
  FINGERPRINT_ERROR: 'fingerprint_error',
};

const STATUS_MESSAGES = {
  [STATUS.OK]: '已授权',
  [STATUS.MISSING]: '未检测到有效授权，请输入激活码激活',
  [STATUS.CORRUPTED]: '授权文件已损坏，请重新激活',
  [STATUS.SIGNATURE_INVALID]: '凭证无效（签名校验失败），请重新激活',
  [STATUS.MACHINE_MISMATCH]: '授权与当前设备不匹配，请重新激活',
  [STATUS.EXPIRED]: '授权已过期，请输入激活码重新激活',
  [STATUS.CLOCK_ROLLBACK]: '检测到系统时间异常，请校正系统时间后重新激活',
  [STATUS.FINGERPRINT_ERROR]: '无法采集设备特征，请联系支持',
};

function normalize(value) {
  return String(value || '').split(/\s+/).join('').toUpperCase();
}

function computeMachineId(sourceTag, value) {
  const raw = `${sourceTag}:${normalize(value)}`;
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function getMacAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const list = interfaces[name] || [];
    for (const net of list) {
      if (net && !net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
        const clean = net.mac.replace(/[:-]/g, '').toLowerCase();
        if (clean.length === 12) {
          const firstByte = parseInt(clean.slice(0, 2), 16);
          if ((firstByte & 0x01) === 0) {
            return clean;
          }
        }
      }
    }
  }
  return null;
}

function getWindowsMachineGuid() {
  try {
    const stdout = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
    const match = stdout.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
    if (match && match[1] && match[1].trim()) {
      return match[1].trim();
    }
  } catch (err) {}
  return null;
}

let cachedMachineId = null;

function collectMachineId() {
  if (cachedMachineId) return cachedMachineId;
  const isWin = process.platform === 'win32';

  if (isWin) {
    const guid = getWindowsMachineGuid();
    if (guid) {
      cachedMachineId = computeMachineId('winreg_machineguid', guid);
      return cachedMachineId;
    }
  }

  const mac = getMacAddress();
  if (mac) {
    cachedMachineId = computeMachineId('mac_address', mac);
    return cachedMachineId;
  }

  const hostname = os.hostname() || 'gpt-register-client';
  cachedMachineId = computeMachineId('fallback_host', hostname);
  return cachedMachineId;
}

function getLicensePath() {
  return path.join(os.homedir(), '.license_guard', 'license.dat');
}

function verifySignature(canonicalBytes, signatureBytes) {
  try {
    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(canonicalBytes);
    return verify.verify(PUBLIC_KEY_PEM, signatureBytes);
  } catch (e) {
    return false;
  }
}

function checkLicense() {
  const licPath = getLicensePath();
  if (!fs.existsSync(licPath)) {
    return { status: STATUS.MISSING, message: STATUS_MESSAGES[STATUS.MISSING] };
  }

  let data;
  let canonical;
  let signature;
  let lastSeen;
  try {
    const rawText = fs.readFileSync(licPath, 'utf8');
    data = JSON.parse(rawText);
    canonical = Buffer.from(data.payload_b64, 'base64');
    signature = Buffer.from(data.signature_b64, 'base64');
    lastSeen = Number(data.last_seen) || 0;
  } catch (err) {
    return { status: STATUS.CORRUPTED, message: STATUS_MESSAGES[STATUS.CORRUPTED] };
  }

  if (!verifySignature(canonical, signature)) {
    return { status: STATUS.SIGNATURE_INVALID, message: STATUS_MESSAGES[STATUS.SIGNATURE_INVALID] };
  }

  let payload;
  try {
    payload = JSON.parse(canonical.toString('utf8'));
  } catch (err) {
    return { status: STATUS.CORRUPTED, message: STATUS_MESSAGES[STATUS.CORRUPTED] };
  }

  const machineId = collectMachineId();
  if (payload.machine_id !== machineId) {
    return { status: STATUS.MACHINE_MISMATCH, message: STATUS_MESSAGES[STATUS.MACHINE_MISMATCH], payload };
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Number(payload.expires_at) || 0;
  if (now >= expiresAt) {
    return { status: STATUS.EXPIRED, message: STATUS_MESSAGES[STATUS.EXPIRED], payload };
  }

  if (now < lastSeen) {
    return { status: STATUS.CLOCK_ROLLBACK, message: STATUS_MESSAGES[STATUS.CLOCK_ROLLBACK], payload };
  }

  try {
    data.last_seen = now;
    const tmpPath = `${licPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
    fs.renameSync(tmpPath, licPath);
  } catch (err) {}

  return { status: STATUS.OK, message: STATUS_MESSAGES[STATUS.OK], payload };
}

function saveLicense(payloadB64, signatureB64) {
  const licPath = getLicensePath();
  const dir = path.dirname(licPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const now = Math.floor(Date.now() / 1000);
  const record = {
    payload_b64: payloadB64,
    signature_b64: signatureB64,
    last_seen: now,
  };

  const tmpPath = `${licPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(record), 'utf8');
  fs.renameSync(tmpPath, licPath);
}

async function activateLicense(code) {
  const cleanCode = String(code || '').trim();
  if (!cleanCode) {
    return { status: 'invalid_input', message: '请输入激活码' };
  }

  const machineId = collectMachineId();
  const nonce = crypto.randomBytes(8).toString('hex');

  try {
    const resp = await fetch(`${SERVER_URL.replace(/\/+$/, '')}/api/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: cleanCode,
        machine_id: machineId,
        nonce,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (resp.status === 403) {
      return { status: 'invalid_code', message: '激活码错误，请检查后重试' };
    }

    if (resp.status === 429) {
      return { status: 'rate_limited', message: '尝试过于频繁，请稍后再试' };
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { status: 'activate_failed', message: `激活失败 (HTTP ${resp.status}): ${errText || '未知错误'}` };
    }

    const body = await resp.json();
    if (!body.payload_b64 || !body.signature_b64) {
      return { status: 'activate_failed', message: '激活服务返回格式无效' };
    }

    const canonical = Buffer.from(body.payload_b64, 'base64');
    const signature = Buffer.from(body.signature_b64, 'base64');
    if (!verifySignature(canonical, signature)) {
      return { status: 'signature_invalid', message: '服务返回的授权签名校验失败' };
    }

    saveLicense(body.payload_b64, body.signature_b64);
    return { status: STATUS.OK, message: '激活成功' };
  } catch (err) {
    return { status: 'network_error', message: `连接激活服务器失败：${err.message || err}` };
  }
}

function getLicenseStatus(isPackaged = true) {
  if (!isPackaged) {
    const result = checkLicense();
    if (result.status === STATUS.OK) {
      return { ...result, isPackaged: false };
    }
    return { status: STATUS.OK, message: '开发环境已放行（未打包）', isPackaged: false };
  }
  return { ...checkLicense(), isPackaged: true };
}

module.exports = {
  STATUS,
  STATUS_MESSAGES,
  SERVER_URL,
  EXPECTED_CODE,
  collectMachineId,
  checkLicense,
  saveLicense,
  activateLicense,
  getLicenseStatus,
  getLicensePath,
};
