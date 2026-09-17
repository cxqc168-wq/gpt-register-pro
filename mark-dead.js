const fs = require('fs');
const regs = JSON.parse(fs.readFileSync('accounts.json','utf8'));
const dead = ['+639050668187','+639559509484','+639559513120'];
for (const phone of dead) {
  const acc = regs.find(r => r.phone === phone);
  if (acc) {
    acc.status = '废弃';
    acc.deadReason = 'Incorrect phone number or password（注册时未设置密码，号码已回收无法重置）';
    console.log(`已标记废弃: ${phone} (${acc.name})`);
  }
}
fs.writeFileSync('accounts.json', JSON.stringify(regs, null, 2));
console.log('accounts.json 已更新');
