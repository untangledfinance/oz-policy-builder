import subprocess,sys,shutil,json,os
src=open('../near/lib.new.rs').read()
N=sys.argv[1] if len(sys.argv)>1 else '20000'
muts=[
("N01 key decode result inverted",'decode_to_slice(key, &mut k).is_ok()','decode_to_slice(key, &mut k).is_err()'),
("N02 key refusal text",'is_ok(), "key"','is_ok(), "k"'),
("N03 signature refusal text",'"signature"','"sig"'),
("N04 key check bypassed",'decode_to_slice(key, &mut k).is_ok()','decode_to_slice(key, &mut k).is_ok() || true'),
("N05 signature check bypassed",'decode_to_slice(signature, &mut s).is_ok()','decode_to_slice(signature, &mut s).is_ok() || true'),
("N06 signature result inverted",'decode_to_slice(signature, &mut s).is_ok()','decode_to_slice(signature, &mut s).is_err()'),
("N07 alg picks Eddsa for domain 0",'if domain_id == 0 { "Ecdsa" } else { "Eddsa" }','if domain_id != 0 { "Ecdsa" } else { "Eddsa" }'),
("N08 alg always Ecdsa",'if domain_id == 0 { "Ecdsa" } else { "Eddsa" }','if domain_id == 0 { "Ecdsa" } else { "Ecdsa" }'),
("N09 alg label typo",'"Eddsa"','"Eddsa2"'),
("N10 payload_v2 carries path",'{ alg: payload }','{ alg: path }'),
("N11 text path label",'\\npath: {path}','\\npath:{path}'),
("N12 text domain label",'\\ndomain: {domain_id}','\\ndomain: {}'),
("N13 text payload label",'\\npayload: {payload}','\\npayload:{payload}'),
("N14 text header",'Prime NEAR signer\\ncontract','Prime NEAR signer \\ncontract'),
("N15 sep53 flag inverted",'if sep53 {','if !sep53 {'),
("N16 sep53 prefix typo",'Stellar Signed Message:\\n','Stellar Signed Message:'),
("N17 verification bypassed",'env::ed25519_verify(&s, &msg, &k), "not','env::ed25519_verify(&s, &msg, &k) || true, "not'),
("N18 verification text",'"not signed by this key"','"bad"'),
("N19 verifies text not msg",'env::ed25519_verify(&s, &msg, &k)','env::ed25519_verify(&s, text_for_mut.as_bytes(), &k)'),
("N20 path uses raw key string",'hex::encode(k)','key_for_mut'),
("N21 request domain_id zeroed",'"domain_id": domain_id }','"domain_id": 0 }'),
("N22 method name",'"sign",','"sign2",'),
("N23 deposit zero",'env::attached_deposit()','near_sdk::NearToken::from_yoctonear(0)'),
("N24 gas weight 2",'GasWeight(1)','GasWeight(2)'),
("N25 gas fixed 1 Tgas",'Gas::from_tgas(0)','Gas::from_tgas(1)'),
("N26 MPC default account",'"v1.signer-prod.testnet"','"v2.signer-prod.testnet"'),
("N27 request key renamed",'"request":','"req":'),
("N28 path key renamed",'"path":','"p":'),
("N29 path separator",'"{}/{path}"','"{}:{path}"'),
]
res=[]
for name,old,new in muts:
    if src[src.index('pub fn sign'):].count(old)<1:
        res.append((name,'NOAPPLY')); print(name,'NOAPPLY'); continue
    h=src.index('pub fn sign'); t=src[:h]+src[h:].replace(old,new,1)
    # helpers some mutants need
    if 'text_for_mut' in t: t=t.replace('let msg =','let text_for_mut = text.clone();\n        let msg =',1)
    if 'key_for_mut' in t: t=t.replace('let msg =','let key_for_mut = key.clone();\n        let msg =',1).replace('decode_to_slice(key, &mut k)','decode_to_slice(key.clone(), &mut k)',1)
    open('new/src/lib.rs','w').write(t)
    b=subprocess.run(['cargo','build','--offline','--release','-p','signer-diff'],capture_output=True,text=True,env={**os.environ,'CARGO_NET_OFFLINE':'true'})
    if b.returncode!=0:
        res.append((name,'KILLED(compile)')); print(name,'KILLED(compile)',flush=True); continue
    r=subprocess.run(['./target/release/signer-diff',N],capture_output=True,text=True)
    st='KILLED' if r.returncode!=0 else 'SURVIVED'
    res.append((name,st)); print(name,st,flush=True)
shutil.copy('../near/lib.new.rs','new/src/lib.rs')
json.dump(res,open('mut-near.json','w'),indent=1)
print('survivors:',[n for n,s in res if s in('SURVIVED','NOAPPLY')])
