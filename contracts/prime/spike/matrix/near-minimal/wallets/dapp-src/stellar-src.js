import * as lobstrApi from '@lobstrco/signer-extension-api';
import albedo from '@albedo-link/intent';
const err = (e) => { throw new Error('ERR ' + JSON.stringify(e instanceof Error ? { message: e.message } : e)); };
const wrap = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { err(e); } };
const keys = (o) => { try { return o ? Object.keys(o).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(o) ?? {})).filter((k) => k !== 'constructor') : null; } catch { return null; } };
window.wm = {
  detect: () => ({ hana: keys(window.hanaWallet?.stellar), hanaTop: keys(window.hanaWallet), rabet: keys(window.rabet), xbull: keys(window.xBullSDK), freighter: keys(window.freighterApi), lobstrConnected: null }),
  lobstr: {
    keys: () => Object.keys(lobstrApi),
    connected: wrap(() => lobstrApi.isConnected()),
    connect: wrap(() => lobstrApi.getPublicKey()),
    signMessage: wrap((m) => lobstrApi.signMessage(m)),
    signTransaction: wrap((x) => lobstrApi.signTransaction(x)),
  },
  albedo: {
    connect: wrap(() => albedo.publicKey({})),
    signMessage: wrap((m) => albedo.signMessage({ message: m })),
    signTransaction: wrap((xdr, address, network) => albedo.tx({ xdr, network: 'testnet', submit: false })),
    raw: wrap((intent, params) => albedo[intent](params)),
  },
  xbull: {
    connect: wrap(() => window.xBullSDK.getAddress()),
    signMessage: wrap((m, address, networkPassphrase) => window.xBullSDK.signMessage(m, { address, networkPassphrase })),
    signAuthEntry: wrap((x, address) => window.xBullSDK.signAuthEntry({ xdr: x, opts: { address } })),
    signTransaction: wrap((xdr, address, networkPassphrase) => window.xBullSDK.signTransaction({ xdr, opts: { networkPassphrase, address } })),
  },
  hana: {
    connect: wrap(() => window.hanaWallet.stellar.getPublicKey()),
    signMessage: wrap((message, accountToSign) => window.hanaWallet.stellar.signMessage({ message, accountToSign })),
    signAuthEntry: wrap((xdr, accountToSign) => window.hanaWallet.stellar.signAuthEntry({ xdr, accountToSign })),
    signTransaction: wrap((xdr, accountToSign, networkPassphrase) => window.hanaWallet.stellar.signTransaction({ xdr, accountToSign, networkPassphrase })),
  },
  rabet: {
    connect: wrap(() => window.rabet.connect()),
    signMessage: wrap((m) => window.rabet.signMessage(m)),
    sign: wrap((xdr, network) => window.rabet.sign(xdr, network)),
    signAuthEntry: wrap((x) => window.rabet.signAuthEntry(x)),
    call: wrap((method, ...a) => window.rabet[method](...a)),
  },
};
