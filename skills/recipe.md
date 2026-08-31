# Daski payment recipe

Daski uses x402 V2 Exact-EVM and USDC `TransferWithAuthorization`. The authorization object is closed and contains exactly `from`, `to`, `value`, `validAfter`, `validBefore`, and `nonce`. Signatures must be 65-byte low-s ECDSA signatures that recover to `from`.

## recipeNonceV2

The v2 nonce is the keccak256 hash of ABI encoding this type hash and fields in order:

`DaskiOrderBindingV2(uint256 chainId,address canonicalToken,address payer,address splitter,uint256 grossAmount,bytes32 runtimeCommitmentHash,bytes32 providerIntentHash,bytes32 quoteHash,bytes32 canonicalRequestHash,bytes32 orderNonce)`

Map the issued order slots exactly: `runtimeCommitmentHash = order.listingManifestHash` and `providerIntentHash = order.providerOfferHash`. Then append quoteHash, canonicalRequestHash, and orderNonce. Use Solidity ABI types `bytes32,uint256,address,address,address,uint256,bytes32,bytes32,bytes32,bytes32,bytes32`, with the type hash first.

Legacy `recipeNonce` uses the corresponding v1 type string and the names `listingManifestHash` and `providerOfferHash` in those two slots. Do not substitute JSON hashing or packed encoding.

Stock-fixed orders use the issued orderNonce. All profiles accept `validAfter = 0` or a timestamp between serverTime minus 3600 seconds and serverTime. `validBefore` must be more than ten seconds after server time and no later than order expiry.

Echo resource and accepted exactly. Echo every required extension and the exact issued values; omit `daski-sign-request` from the paid payload (an accidental echo is ignored). The required payment identifier must retain its issued id.

## Fixture vector

The fixture in `test/standardPaymentEcho.test.ts` uses chainId 84532, token `0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, payer `0x1563915e194D8CfBA1943570603F7606A3115508`, splitter `0x4444444444444444444444444444444444444444`, amount 46800000, runtime/provider/quote/request/order hashes filled respectively with bytes 0x11/0x22/0x33/0x44/0x55. The expected recipeNonceV2 is:

`0x4458cb7550c233739bed9718355ae8f8ee844146abad79b6983d011b793ecdf3`
