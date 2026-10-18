import subprocess,sys,shutil,json
src=open(sys.argv[1]).read()
muts=[
("M01 grant sig == owner -> !=",'sig) == owner, "grant sig"','sig) != owner, "grant sig"'),
("M02 grant sig check bypassed",'sig) == owner, "grant sig"','sig) == owner || true, "grant sig"'),
("M03 end == 0 || -> end != 0 ||","end == 0 || (s.until","end != 0 || (s.until"),
("M04 revoke path needs the window checks","end == 0 || (s.until","false || (s.until"),
("M05 until < end -> <=","s.until < end","s.until <= end"),
("M06 until < end removed","s.until < end &&","true &&"),
("M07 now < end -> <=","block.timestamp < end &&","block.timestamp <= end &&"),
("M08 now < end removed","block.timestamp < end &&","true &&"),
("M09 end <= now+7d -> <","end <= block.timestamp + 7 days","end < block.timestamp + 7 days"),
("M10 grant cap 7 -> 8 days","end <= block.timestamp + 7 days","end <= block.timestamp + 8 days"),
("M11 grant cap removed","&& end <= block.timestamp + 7 days","&& true"),
("M12 revoke marker max-1","type(uint128).max : uint128(end)","type(uint128).max - 1 : uint128(end)"),
("M13 end==0 ? flipped","end == 0 ? type(uint128).max","end != 0 ? type(uint128).max"),
("M14 stored until +1",": uint128(end);",": uint128(end) + 1;"),
("M15 exec now <= until -> <","block.timestamp <= s.until","block.timestamp < s.until"),
("M16 exec lower bound removed","block.timestamp <= s.until &&","true &&"),
("M17 exec until <= now+7d -> <","s.until <= block.timestamp + 7 days","s.until < block.timestamp + 7 days"),
("M18 exec cap 7 -> 8 days","s.until <= block.timestamp + 7 days","s.until <= block.timestamp + 8 days"),
("M19 exec cap removed","&& s.until <= block.timestamp + 7 days","&& true"),
("M20 nonce not advanced","s.nonce++","s.nonce"),
("M21 nonce pre-increment","s.nonce++","++s.nonce"),
("M22 digest without contract address","abi.encode(address(this),","abi.encode(address(0),"),
("M23 digest without chain id","block.chainid, s.nonce++","uint256(1), s.nonce++"),
("M24 digest without to","s.nonce++, to, value","s.nonce++, address(0), value"),
("M25 digest without value","to, value, keccak256(data)","to, uint256(0), keccak256(data)"),
("M26 digest without data","value, keccak256(data), op","value, keccak256(\"\"), op"),
("M27 digest without op","keccak256(data), op, role","keccak256(data), uint8(0), role"),
("M28 digest without role","op, role));","op, bytes32(0)));"),
("M29 session sig == key -> !=",'== key, "session sig"','!= key, "session sig"'),
("M30 session sig bypassed",'== key, "session sig"','== key || true, "session sig"'),
("M31 shouldRevert false","role, true);","role, false);"),
("M32 roles value dropped","(to, value, data, op, role, true)","(to, 0, data, op, role, true)"),
("M33 roles data dropped","(to, value, data, op, role, true)","(to, value, \"\", op, role, true)"),
("M34 roles op dropped","(to, value, data, op, role, true)","(to, value, data, 0, role, true)"),
("M35 roles role dropped","(to, value, data, op, role, true)","(to, value, data, op, bytes32(0), true)"),
("M36 roles to dropped","(to, value, data, op, role, true)","(address(0), value, data, op, role, true)"),
("M37 constructor owner not stored","(owner, roles) = (owner_, roles_);","(owner, roles) = (address(0), roles_);"),
("M38 constructor roles not stored","(owner, roles) = (owner_, roles_);","(owner, roles) = (owner_, IRoles(address(0)));"),
("M39 struct fields swapped","uint128 until; uint128 nonce;","uint128 nonce; uint128 until;"),
("M40 struct until narrowed","uint128 until; uint128 nonce;","uint64 until; uint128 nonce;"),
("M41 grantText prefix","\"Prime session\\ncontract: \"","\"Prime session\\ncontract:\""),
("M42 grantText key label","\"\\nsession key: \"","\"\\nsession  key: \""),
("M43 grantText end label","\"\\nvalid until (unix time): \"","\"\\nvalid until: \""),
("M44 grantText network label","\"\\nnetwork: \"","\"\\nchain: \""),
("M45 grantText contract = key","Strings.toHexString(address(this))","Strings.toHexString(key)"),
("M46 grantText end +1","Strings.toString(end)","Strings.toString(end + 1)"),
("M47 grantText chain constant","Strings.toString(block.chainid)","Strings.toString(uint256(1))"),
("M48 grant pointer to owner slot","Session storage s = sessions[key];\n        require(ECDSA","Session storage s = sessions[owner];\n        require(ECDSA"),
("M49 exec pointer to wrong slot","Session storage s = sessions[key];\n        require(block","Session storage s = sessions[to];\n        require(block"),
("M50 no EIP-191 prefix","bytes(grantText(key, end)).toEthSignedMessageHash()","keccak256(bytes(grantText(key, end)))"),
("M51 revert text grant sig",'"grant sig"','"x"'),
("M52 revert text grant",'"grant");','"x");'),
("M53 revert text session",'"session");','"x");'),
("M54 revert text session sig",'"session sig"','"x"'),
("M55 interface op type","uint8, bytes32, bool) external","uint256, bytes32, bool) external"),
("M56 interface drops return","external returns (bool);","external;"),
("M57 exec message hash unsigned","ECDSA.recover(h, sig)","ECDSA.recover(keccak256(abi.encode(h)), sig)"),
]
res=[]
shutil.copy('src/PrimeSession.sol','/tmp/ps_backup.sol')
for name,old,new in muts:
    if src.count(old)<1:
        res.append((name,'NOAPPLY')); print(name,'NOAPPLY'); continue
    t=src.replace(old,new,1)
    open('src/PrimeSession.sol','w').write(t)
    r=subprocess.run(['/home/ubuntu/.foundry/bin/forge','test'],capture_output=True,text=True)
    out=r.stdout+r.stderr
    st='KILLED' if r.returncode!=0 else 'SURVIVED'
    if r.returncode!=0 and 'Compiler run failed' in out: st='KILLED(compile)'
    res.append((name,st)); print(name,st,flush=True)
shutil.copy('/tmp/ps_backup.sol','src/PrimeSession.sol')
json.dump(res,open(sys.argv[2],'w'),indent=1)
print('survivors:',[n for n,s in res if s in('SURVIVED','NOAPPLY')])
