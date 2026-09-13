import tls from 'tls';

// RFC 5321 单行上限 998 字节，QQ SMTP 对超长行整封拒收（500 Line too long，2026-09-02 实战踩坑）。
// 按「字符」累积到 ≤200 字节再断行：UTF-8 汉字 3 字节不会被截断。
export function wrapBodyForSmtp(text, maxBytes = 200) {
  const out = [];
  for (const rawLine of String(text).split('\n')) {
    if (Buffer.byteLength(rawLine, 'utf8') <= maxBytes) { out.push(rawLine); continue; }
    let cur = '', curBytes = 0;
    for (const ch of rawLine) {
      const b = Buffer.byteLength(ch, 'utf8');
      if (curBytes + b > maxBytes) { out.push(cur); cur = ch; curBytes = b; }
      else { cur += ch; curBytes += b; }
    }
    if (cur) out.push(cur);
  }
  return out.join('\r\n');
}

// 最小化 SMTP 发送（QQ 邮箱 smtp.qq.com:465 隐式 TLS），零依赖。
// user/pass 为 QQ 邮箱地址与 SMTP 授权码（非登录密码）。
export function sendEmail({ host = 'smtp.qq.com', port = 465, user, pass, to, subject, text }) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(port, host, { servername: host }, () => {});
    let buf = '';
    let stage = 'connect';
    const write = (s) => sock.write(s + '\r\n');
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

    function handle(line) {
      const code = line.slice(0, 3);
      switch (stage) {
        case 'connect':
          if (code === '220') { write('EHLO localhost'); stage = 'ehlo'; }
          else return reject(new Error('connect failed: ' + line));
          break;
        case 'ehlo':
          if (line.startsWith('250')) {
            if (line[3] === ' ') { write('AUTH LOGIN'); stage = 'auth-user'; }
          } else return reject(new Error('ehlo failed: ' + line));
          break;
        case 'auth-user':
          if (code === '334') { write(b64(user)); stage = 'auth-pass'; }
          else return reject(new Error('auth-user failed: ' + line));
          break;
        case 'auth-pass':
          if (code === '334') { write(b64(pass)); stage = 'authed'; }
          else return reject(new Error('auth-pass failed: ' + line));
          break;
        case 'authed':
          if (code === '235') { write(`MAIL FROM:<${user}>`); stage = 'mail'; }
          else return reject(new Error('auth failed: ' + line));
          break;
        case 'mail':
          if (code === '250') { write(`RCPT TO:<${to}>`); stage = 'rcpt'; }
          else return reject(new Error('mail failed: ' + line));
          break;
        case 'rcpt':
          if (code === '250') { write('DATA'); stage = 'data'; }
          else return reject(new Error('rcpt failed: ' + line));
          break;
        case 'data':
          if (code === '354') {
            const body = wrapBodyForSmtp(text).replace(/^\./gm, '..');
            const msg = [
              `From: ${user}`,
              `To: ${to}`,
              `Subject: =?UTF-8?B?${b64(subject)}?=`,
              'MIME-Version: 1.0',
              'Content-Type: text/plain; charset=UTF-8',
              '',
              body,
              '.'
            ].join('\r\n');
            write(msg);
            stage = 'body';
          } else return reject(new Error('data failed: ' + line));
          break;
        case 'body':
          if (code === '250') { write('QUIT'); stage = 'quit'; }
          else return reject(new Error('body failed: ' + line));
          break;
        case 'quit':
          if (code === '221') { sock.end(); return resolve(true); }
          else return reject(new Error('quit failed: ' + line));
          break;
      }
    }

    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        handle(line);
      }
    });
    sock.on('error', reject);
    sock.on('close', () => { if (stage !== 'quit') reject(new Error('connection closed at stage ' + stage)); });
    sock.setTimeout(30000, () => { sock.destroy(); reject(new Error('smtp timeout')); });
  });
}
