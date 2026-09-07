import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('isolated runtime proof RPC facts', () => {
  it('reads full captured bytecode without the per-environment-variable spawn limit', () => {
    const directory=mkdtempSync(join(tmpdir(),'gateway-rpc-file-test-'));
    try {
      const path=join(directory,'facts.json');
      const code='0x'+'60'.repeat(200000);
      writeFileSync(path,JSON.stringify({schemaVersion:1,blockNumber:'0x1',code:{['0x'+'1'.repeat(40)]:code},storage:{},calls:{}}),{mode:0o600});
      const result=spawnSync(process.execPath,['--import',resolve('scripts/reliability/controlled-network.mjs'),'--input-type=module','-e',
        `const response=await fetch('https://rpc.reliability.invalid/',{body:JSON.stringify({id:1,method:'eth_getCode',params:['0x'+'1'.repeat(40),'0x1']})});process.stdout.write(String((await response.json()).result.length));`],
        {encoding:'utf8',env:{PATH:process.env.PATH,DASKI_ISOLATED_STARTUP_PROOF:'1',DASKI_PROOF_RPC_FACTS_PATH:path,DASKI_PROOF_FACILITATOR_URL:'https://facilitator.example.invalid'}});
      expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stdout).toBe(String(code.length));
    } finally {rmSync(directory,{recursive:true,force:true});}
  });
  it('rejects an oversized facts file before loading the runtime', () => {
    const directory=mkdtempSync(join(tmpdir(),'gateway-rpc-size-test-'));
    try {
      const path=join(directory,'facts.json');writeFileSync(path,'{}',{mode:0o600});truncateSync(path,16*1024*1024+1);
      const result=spawnSync(process.execPath,['--import',resolve('scripts/reliability/controlled-network.mjs'),'-e',"process.stdout.write('runtime started')"],
        {encoding:'utf8',env:{PATH:process.env.PATH,DASKI_ISOLATED_STARTUP_PROOF:'1',DASKI_PROOF_RPC_FACTS_PATH:path}});
      expect(result.status).not.toBe(0);expect(result.stdout).toBe('');expect(result.stderr).toContain('bounded regular file');
    } finally {rmSync(directory,{recursive:true,force:true});}
  });
});
