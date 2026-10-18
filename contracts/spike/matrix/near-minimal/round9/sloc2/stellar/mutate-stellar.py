import subprocess,sys,shutil,json
src=open('lib.fmt.rs').read()
muts=[
("S01 cap > -> >=","ttl > 120_960","ttl >= 120_960"),
("S02 cap 120_960 -> 120_961","ttl > 120_960","ttl > 120_961"),
("S03 cap check removed","ttl > 120_960 ||","false ||"),
("S04 revoked check on revoke too","until != 0 &&","until == 0 &&"),
("S05 revoked check always","until != 0 &&","true &&"),
("S06 revoked check never","== Some(0u32)","== Some(1u32)"),
("S07 revoked check inverted","== Some(0u32)","!= Some(0u32)"),
("S08 ttl without saturation","until.saturating_sub(e.ledger().sequence())","until - e.ledger().sequence()"),
("S09 stored until zeroed","set(&key, &until)","set(&key, &0)"),
("S10 stored until +1","set(&key, &until)","set(&key, &(until + 1))"),
("S11 revoke arm 0 -> 1","0 => e.storage().max_ttl()","1 => e.storage().max_ttl()"),
("S12 grant arm ttl -> 0","_ => ttl,","_ => 0,"),
("S13 revoke uses ttl not max_ttl","0 => e.storage().max_ttl()","0 => ttl"),
("S14 extend to 0","extend_ttl(&key, ttl, ttl)","extend_ttl(&key, 0, 0)"),
("S15 extend threshold only","extend_ttl(&key, ttl, ttl)","extend_ttl(&key, 0, ttl)"),
("S16 owner auth removed","        Address::require_auth(&e.storage().instance().get(&0u32).unwrap());\n",""),
("S17 constructor key moved","set(&0u32, &owner)","set(&1u32, &owner)"),
("S18 grant error code 2","        if ttl > 120_960 || (until != 0 && e.storage().temporary().get(&key) == Some(0u32)) {\n            return Err(Error::from_contract_error(1));","        if ttl > 120_960 || (until != 0 && e.storage().temporary().get(&key) == Some(0u32)) {\n            return Err(Error::from_contract_error(2));"),
("S19 check_auth <  -> <=","unwrap_or(0u32) < e.ledger().sequence()","unwrap_or(0u32) <= e.ledger().sequence()"),
("S20 check_auth default max","unwrap_or(0u32)","unwrap_or(u32::MAX)"),
("S21 check_auth error code 2","        if e.storage().temporary().get(&p.0).unwrap_or(0u32) < e.ledger().sequence() {\n            return Err(Error::from_contract_error(1));","        if e.storage().temporary().get(&p.0).unwrap_or(0u32) < e.ledger().sequence() {\n            return Err(Error::from_contract_error(2));"),
("S22 signature check removed","        Ok(e.crypto().ed25519_verify(&p.0, &payload.into(), &p.1))","        Ok(())"),
("S23 verify other key (sig as key)","ed25519_verify(&p.0, &payload.into(), &p.1)","ed25519_verify(&p.0, &BytesN::from_array(&e, &[0u8; 32]).into(), &p.1)"),
("S24 grant reads persistent for revoked check","if ttl > 120_960 || (until != 0 && e.storage().temporary().get","if ttl > 120_960 || (until != 0 && e.storage().persistent().get"),
("S25 check_auth reads persistent","e.storage().temporary().get(&p.0)","e.storage().persistent().get(&p.0)"),
("S26 grant stores persistent","e.storage().temporary().set(&key, &until);\n","e.storage().persistent().set(&key, &until);\n"),
("S27 cap uses day-less ledgers 120_960 -> 17_280","ttl > 120_960","ttl > 17_280"),
("S28 revoked check ignores key","get(&key) == Some(0u32)","get(&BytesN::from_array(&e, &[0u8; 32])) == Some(0u32)"),
]
res=[]
shutil.copy('src/lib.rs','/tmp/stellar_backup.rs')
for name,old,new in muts:
    if src.count(old)<1:
        res.append((name,'NOAPPLY')); print(name,'NOAPPLY'); continue
    t=src.replace(old,new,1)
    open('src/lib.rs','w').write(t)
    r=subprocess.run(['cargo','test','--offline'],capture_output=True,text=True,env={**__import__('os').environ,'CARGO_NET_OFFLINE':'true'})
    out=r.stdout+r.stderr
    st='KILLED' if r.returncode!=0 else 'SURVIVED'
    if r.returncode!=0 and 'could not compile' in out: st='KILLED(compile)'
    res.append((name,st)); print(name,st,flush=True)
shutil.copy('/tmp/stellar_backup.rs','src/lib.rs')
json.dump(res,open('mut-stellar.json','w'),indent=1)
print('survivors:',[n for n,s in res if s in('SURVIVED','NOAPPLY')])
