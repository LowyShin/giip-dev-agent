#!/usr/bin/env node
// get-issue.sh 헬퍼: giip-accounts.json 에서 csn -> sk 를 찾는다.
// 사용: node resolve-sk.js <accountsFile> <csn>       -> sk 출력
//       node resolve-sk.js <accountsFile> --list       -> 등록된 csn 목록 출력
const fs = require('fs');

const [, , accountsFile, csnArg] = process.argv;
const data = JSON.parse(fs.readFileSync(accountsFile, 'utf-8'));
const channels = Object.values(data.channels || {});
const defaultEntry = data.default ? [data.default] : [];

if (csnArg === '--list') {
  const all = [...channels, ...defaultEntry].map((c) => c.csn);
  console.log([...new Set(all)].join(', '));
  process.exit(0);
}

const allEntries = [...channels, ...defaultEntry];

if (csnArg) {
  const match = allEntries.find((c) => String(c.csn) === String(csnArg));
  if (!match) process.exit(1);
  console.log(match.sk);
  process.exit(0);
}

const uniqueCsns = [...new Set(allEntries.map((c) => c.csn))];
if (uniqueCsns.length === 1) {
  console.log(allEntries.find((c) => c.csn === uniqueCsns[0]).sk);
  process.exit(0);
}
process.exit(1);
