import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
const databaseUrl=process.env.DATABASE_URL_TEST??"postgresql://postgres:password@localhost:5433/daski_gateway_test";
let admin:Pool,pool:Pool,schema:string;
beforeEach(async()=>{
 schema="migration_overlap_"+randomUUID().replaceAll("-","");
 admin=createPool({connectionString:databaseUrl,max:1});await admin.query('CREATE SCHEMA "'+schema+'"');
 pool=createPool({connectionString:databaseUrl,searchPath:schema+",public",max:5});
 await runMigrations(pool,{through:"055_sale_guard_read_locks.sql"});
});
afterEach(async()=>{await pool?.end();await admin?.query('DROP SCHEMA "'+schema+'" CASCADE');await admin?.end();});
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
it("yields the DDL lock queue promptly while an incumbent transaction is open",async()=>{
 const reader=await pool.connect();
 let migration:Promise<void>|undefined;
 try{
  await reader.query("BEGIN");await reader.query("SELECT 1 FROM standard_orders");
  let settled=false;
  migration=runMigrations(pool).finally(()=>{settled=true;});
  const checked=migration.then(()=>null,error=>error);
  await wait(150);expect(settled).toBe(false);
  const live=await pool.connect();
  try{
   await live.query("SET statement_timeout='500ms'");
   for(let i=0;i<3;i++)await live.query("SELECT 1 FROM standard_orders");
  }finally{live.release();}
  await reader.query("COMMIT");
  expect(await checked).toBeNull();
  const applied=await pool.query("SELECT name FROM _migrations WHERE name>='056_' ORDER BY name");
  expect(applied.rows.map(row=>row.name)).toEqual(["056_sale_guard_install_complete.sql","057_contract_retirement.sql","058_retirement_post_completion.sql","059_retirement_journal_serialization.sql"]);
 }finally{await reader.query("ROLLBACK");reader.release();await migration?.catch(()=>undefined);}
},60_000);
it("retries the expansion when the incumbent writes tables in its existing lock order",async()=>{
 await runMigrations(pool,{through:"056_sale_guard_install_complete.sql"});
 const writer=await pool.connect();
 let migration:Promise<void>|undefined;
 try{
  await writer.query("BEGIN");
  await writer.query("LOCK TABLE standard_orders IN ROW SHARE MODE");
  await writer.query("LOCK TABLE standard_settlement_attempts IN ROW EXCLUSIVE MODE");
  migration=runMigrations(pool);
  const checked=migration.then(()=>null,error=>error);
  // Park 057 after its orders trigger lock but before its settlement trigger
  // lock. The incumbent then needs to promote its existing orders read lock.
  let observed=false;
  for(let i=0;i<100&&!observed;i++){
    observed=(await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='standard_orders'
      AND l.mode='ShareRowExclusiveLock' AND l.granted) AS present`,[schema])).rows[0].present;
    if(!observed)await wait(5);
  }
  expect(observed).toBe(true);
  await writer.query("SET LOCAL statement_timeout='500ms'");
  await writer.query("LOCK TABLE standard_orders IN ROW EXCLUSIVE MODE");
  await writer.query("COMMIT");
  expect(await checked).toBeNull();
  expect((await pool.query("SELECT count(*)::int n FROM _migrations WHERE name='058_retirement_post_completion.sql'")).rows[0].n).toBe(1);
 }finally{await writer.query("ROLLBACK");writer.release();await migration?.catch(()=>undefined);}
},60_000);
