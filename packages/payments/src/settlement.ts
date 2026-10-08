import { BusinessError, type PaymentObservation, type PaymentRequest } from '../../contracts/index.js';
import { integer, object, type JsonObject } from './common.js';

const blockfrost = 'https://cardano-preprod.blockfrost.io/api/v0';
const hashPattern = /^[a-f0-9]{64}$/;

function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new BusinessError('MASUMI_PAYOUT_UNVERIFIED', 'Confirmed seller settlement evidence is missing or inconsistent', 502);
}
function records(value: unknown): JsonObject[] {
  requireProof(Array.isArray(value));
  return value.map(entry => object(entry));
}
function tag(value: JsonObject): unknown { return value.constructor; }
function quantity(value: unknown): bigint {
  try { return integer(value, 'settlement quantity'); }
  catch { throw new BusinessError('MASUMI_PAYOUT_UNVERIFIED', 'Settlement quantities are invalid', 502); }
}
function lovelace(output: JsonObject, onlyAda = false): bigint {
  const assets = records(output.amount);
  requireProof(!onlyAda || (assets.length === 1 && assets[0].unit === 'lovelace'));
  const ada = assets.filter(asset => asset.unit === 'lovelace');
  requireProof(ada.length === 1);
  return quantity(ada[0].quantity);
}

export function resultAnchor(previous: PaymentObservation | undefined, purchase: JsonObject): { hash: string; index?: number; resultHash: string } {
  requireProof(previous?.raw && typeof previous.raw === 'object');
  const raw = object(previous.raw);
  const prior = object(raw.purchase);
  requireProof(prior.blockchainIdentifier === purchase.blockchainIdentifier && prior.inputHash === purchase.inputHash
    && typeof prior.resultHash === 'string' && hashPattern.test(prior.resultHash) && prior.resultHash === purchase.resultHash);
  if (raw.settlement) {
    const proof = object(raw.settlement);
    requireProof(typeof proof.escrow_transaction_hash === 'string' && hashPattern.test(proof.escrow_transaction_hash)
      && Number.isSafeInteger(proof.escrow_output_index) && Number(proof.escrow_output_index) >= 0
      && proof.result_hash === prior.resultHash);
    return { hash: proof.escrow_transaction_hash, index: Number(proof.escrow_output_index), resultHash: prior.resultHash };
  }
  const remembered = raw.result_transaction_hash;
  const hash = typeof remembered === 'string' ? remembered : previous.transaction_hash;
  requireProof(typeof hash === 'string' && hashPattern.test(hash));
  const current = prior.CurrentTransaction ? object(prior.CurrentTransaction) : undefined;
  const history = Array.isArray(prior.TransactionHistory) ? records(prior.TransactionHistory) : [];
  requireProof((typeof remembered === 'string' || previous.state === 'result_submitted')
    && [current, ...history].some(tx => tx?.status === 'Confirmed' && tx.txHash === hash));
  return { hash, resultHash: prior.resultHash };
}

export async function verifySettlement(input: {
  request: PaymentRequest; payment: JsonObject; purchase: JsonObject; previous?: PaymentObservation;
  paymentSources: JsonObject; projectId?: string; collectionAddress?: string;
  fetcher: typeof fetch; timeoutMs: number;
}): Promise<JsonObject> {
  const { request, payment, purchase, previous, fetcher } = input;
  requireProof(input.projectId && /^preprod[a-zA-Z0-9]+$/.test(input.projectId));
  const wallet = object(payment.SmartContractWallet);
  const sellerAddress = wallet.walletAddress;
  const collectionAddress = input.collectionAddress ?? sellerAddress;
  requireProof(typeof sellerAddress === 'string' && /^addr_test1[a-z0-9]+$/.test(sellerAddress)
    && typeof collectionAddress === 'string' && /^addr_test1[a-z0-9]+$/.test(collectionAddress));
  const tx = object(purchase.CurrentTransaction);
  requireProof(tx.status === 'Confirmed' && typeof tx.txHash === 'string' && hashPattern.test(tx.txHash));
  const anchor = resultAnchor(previous, purchase);
  requireProof(tx.txHash !== anchor.hash);
  const source = object(purchase.PaymentSource);
  requireProof(typeof source.smartContractAddress === 'string' && source.smartContractAddress.startsWith('addr_test1'));
  const sources = records(input.paymentSources.PaymentSources).filter(candidate => candidate.network === 'Preprod'
    && candidate.policyId === source.policyId && (source.id === undefined || candidate.id === source.id));
  requireProof(sources.length === 1);
  const feeRate = sources[0].feeRatePermille;
  requireProof(Number.isSafeInteger(feeRate) && Number(feeRate) >= 0 && Number(feeRate) <= 1000);
  const feeAddress = object(sources[0].FeeReceiverNetworkWallet).walletAddress;
  requireProof(typeof feeAddress === 'string' && feeAddress.startsWith('addr_test1')
    && feeAddress !== collectionAddress && feeAddress !== sellerAddress);
  async function get(path: string): Promise<JsonObject> {
    let response: Response;
    try {
      response = await fetcher(`${blockfrost}${path}`, { headers: { project_id: input.projectId! },
        signal: AbortSignal.timeout(input.timeoutMs), redirect: 'error' });
      if (!response.ok) throw new Error();
      return object(await response.json());
    } catch {
      throw new BusinessError('MASUMI_SETTLEMENT_UNAVAILABLE', 'Preprod settlement verification is unavailable; retry observation without another purchase', 503);
    }
  }
  const chain = await get(`/txs/${tx.txHash}`);
  requireProof(chain.hash === tx.txHash && typeof chain.block === 'string' && hashPattern.test(chain.block)
    && Number.isSafeInteger(chain.block_height) && Number(chain.block_height) > 0 && chain.valid_contract === true);
  const utxos = await get(`/txs/${tx.txHash}/utxos`);
  requireProof(utxos.hash === tx.txHash);
  const inputs = records(utxos.inputs).filter(utxo => utxo.collateral === false && utxo.reference !== true);
  const outputs = records(utxos.outputs).filter(utxo => utxo.collateral === false);
  requireProof(new Set(inputs.map(utxo => `${utxo.tx_hash}:${utxo.output_index}`)).size === inputs.length);
  const escrowInputs = inputs.filter(utxo => utxo.tx_hash === anchor.hash && utxo.address === source.smartContractAddress
    && (anchor.index === undefined || utxo.output_index === anchor.index));
  requireProof(escrowInputs.length === 1);
  const escrow = escrowInputs[0];
  requireProof(Number.isSafeInteger(escrow.output_index) && Number(escrow.output_index) >= 0
    && typeof escrow.data_hash === 'string' && hashPattern.test(escrow.data_hash)
    && typeof escrow.inline_datum === 'string' && /^(?:[a-f0-9]{2})+$/.test(escrow.inline_datum));
  const datum = object((await get(`/scripts/datum/${escrow.data_hash}`)).json_value);
  const fields = records(datum.fields);
  requireProof(tag(datum) === 0 && fields.length === 16
    && fields[5].bytes === request.identifier_from_purchaser && fields[7].bytes === request.input_hash
    && fields[8].bytes === anchor.resultHash && tag(fields[15]) === 1
    && Array.isArray(fields[15].fields) && fields[15].fields.length === 0);
  const sellerCredential = object(records(fields[1].fields)[0]);
  requireProof(records(sellerCredential.fields)[0].bytes === request.seller_id);
  for (const [field, index] of [['payByTime', 9], ['submitResultTime', 10], ['unlockTime', 11], ['externalDisputeUnlockTime', 12]] as const) {
    requireProof(quantity(String(fields[index].int)) === quantity(purchase[field]));
  }
  const escrowAmount = lovelace(escrow, true);
  requireProof(request.asset === 'lovelace' && escrowAmount === quantity(request.asset_quantity));
  const percentageFee = escrowAmount * BigInt(Number(feeRate));
  const fee = percentageFee > 1_435_230_000n ? percentageFee / 1000n : 1_435_230n;
  requireProof(percentageFee <= 1_435_230_000n || percentageFee % 1000n === 0n);
  const gross = escrowAmount - fee;
  requireProof(gross > 0n && gross <= quantity(request.asset_quantity));
  const collection = outputs.filter(output => output.output_index === 0);
  requireProof(collection.length === 1 && collection[0].address === collectionAddress
    && collection[0].inline_datum == null && collection[0].data_hash == null && lovelace(collection[0], true) === gross);
  const feeOutputs = outputs.filter(output => output.address === feeAddress && lovelace(output, true) === fee);
  requireProof(feeOutputs.length === 1 && typeof feeOutputs[0].data_hash === 'string' && hashPattern.test(feeOutputs[0].data_hash));
  const reference = object((await get(`/scripts/datum/${feeOutputs[0].data_hash}`)).json_value);
  const referenceFields = records(reference.fields);
  requireProof(tag(reference) === 0 && referenceFields.length === 2 && referenceFields[0].bytes === anchor.hash
    && quantity(String(referenceFields[1].int)) === BigInt(Number(escrow.output_index)));
  const sum = (utxos: JsonObject[]) => utxos.reduce((total, utxo) => total + lovelace(utxo), 0n);
  const chainFee = quantity(chain.fees);
  requireProof(sum(inputs) - sum(outputs) === chainFee);
  const owned = new Set([sellerAddress, collectionAddress]);
  const net = sum(outputs.filter(output => owned.has(String(output.address))))
    - sum(inputs.filter(utxo => owned.has(String(utxo.address))));
  requireProof(net > 0n && net === gross - chainFee);
  return { source: 'blockfrost_preprod', transaction_hash: tx.txHash, escrow_transaction_hash: anchor.hash,
    escrow_output_index: escrow.output_index, result_hash: anchor.resultHash, collection_address: collectionAddress,
    asset: 'lovelace', escrow_lovelace: escrowAmount.toString(), protocol_fee_lovelace: fee.toString(),
    seller_gross_lovelace: gross.toString(), chain_fee_lovelace: chainFee.toString(), seller_net_lovelace: net.toString(),
    net_scope: 'collection_and_seller_wallet' };
}
