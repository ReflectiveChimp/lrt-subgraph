import { Address, BigInt, ethereum, log } from "@graphprotocol/graph-ts"
import {
  Deposit as DepositEvent,
  Withdraw as WithdrawEvent,
  Transfer as TransferEvent,
} from "./../generated/templates/BeefyCLVault/BeefyVaultConcLiq"
import { getBeefyCLVault, getBeefyCLVaultSnapshot, isVaultRunning } from "./entity/vault"
import { getTransaction } from "./entity/transaction"
import { getBeefyCLProtocol, getBeefyCLProtocolSnapshot } from "./entity/protocol"
import { getInvestor, getInvestorSnapshot, isNewInvestor } from "./entity/investor"
import { ZERO_BD, ZERO_BI, tokenAmountToDecimal } from "./utils/decimal"
import { BeefyVaultConcLiq as BeefyCLVaultContract } from "./../generated/templates/BeefyCLVault/BeefyVaultConcLiq"
import { SNAPSHOT_PERIODS } from "./utils/time"
import { getToken } from "./entity/token"
import { getInvestorPosition, getInvestorPositionSnapshot, isNewInvestorPosition } from "./entity/position"
import { ADDRESS_ZERO } from "./utils/address"
import { getCurrentPriceInToken1, getVaultPriceRangeInToken1, getVaultPrices } from "./mapping/price"
import { InvestorPositionInteraction } from "../generated/schema"
import { getEventIdentifier } from "./utils/event"

export function handleVaultDeposit(event: DepositEvent): void {
  updateUserPosition(event, event.params.user, true, false)
}
export function handleVaultWithdraw(event: WithdrawEvent): void {
  updateUserPosition(event, event.params.user, false, false)
}
export function handleVaultTransfer(event: TransferEvent): void {
  updateUserPosition(event, event.params.to, true, true)
  updateUserPosition(event, event.params.from, false, true)
}

function updateUserPosition(
  event: ethereum.Event,
  investorAddress: Address,
  isDeposit: boolean,
  isTransfer: boolean,
): void {
  let vault = getBeefyCLVault(event.address)
  if (!isVaultRunning(vault)) {
    log.error("updateUserPosition: vault {} not active at block {}: {}", [
      vault.id.toHexString(),
      event.block.number.toString(),
      vault.lifecycle,
    ])
    return
  }

  log.debug("updateUserPosition: processing {} for vault {}", [
    isDeposit ? "deposit" : "withdraw",
    vault.id.toHexString(),
  ])

  const periods = SNAPSHOT_PERIODS
  const sharesToken = getToken(vault.sharesToken)
  const token0 = getToken(vault.underlyingToken0)
  const token1 = getToken(vault.underlyingToken1)

  let tx = getTransaction(event.block, event.transaction, event.receipt)
  tx.save()

  let investor = getInvestor(investorAddress)
  const newInvestor = isNewInvestor(investor)

  ///////
  // fetch data on chain
  // TODO: use multicall3 to fetch all data in one call
  log.debug("updateUserPosition: fetching data for vault {}", [vault.id.toHexString()])
  const vaultContract = BeefyCLVaultContract.bind(Address.fromBytes(vault.id))
  const strategyAddress = Address.fromBytes(vault.strategy)

  // current prices
  const currentPriceInToken1 = getCurrentPriceInToken1(strategyAddress, true)
  const rangeToken1Price = getVaultPriceRangeInToken1(strategyAddress, true)

  // balances of the vault
  const vaultBalancesRes = vaultContract.try_balances()
  if (vaultBalancesRes.reverted) {
    log.error("updateUserPosition: balances() reverted for strategy {}", [vault.strategy.toHexString()])
    throw Error("updateUserPosition: balances() reverted")
  }
  const vaultBalanceUnderlying0 = tokenAmountToDecimal(vaultBalancesRes.value.value0, token0.decimals)
  const vaultBalanceUnderlying1 = tokenAmountToDecimal(vaultBalancesRes.value.value1, token1.decimals)

  // get the new investor deposit value
  const investorBalanceRes = vaultContract.try_balanceOf(investorAddress)
  if (investorBalanceRes.reverted) {
    log.error("updateUserPosition: balanceOf() reverted for vault {}", [vault.id.toHexString()])
    throw Error("updateUserPosition: balanceOf() reverted")
  }
  const investorShareTokenBalanceRaw = investorBalanceRes.value
  const investorShareTokenBalance = tokenAmountToDecimal(investorShareTokenBalanceRaw, sharesToken.decimals)

  // get the current user balances by simulating a withdraw
  let previewWithdraw0Raw = BigInt.fromI32(0)
  let previewWithdraw1Raw = BigInt.fromI32(0)
  if (investorShareTokenBalanceRaw.gt(ZERO_BI)) {
    const previewWithdrawRes = vaultContract.try_previewWithdraw(investorShareTokenBalanceRaw)
    if (previewWithdrawRes.reverted) {
      log.error("updateUserPosition: previewWithdraw() reverted for vault {}", [vault.id.toHexString()])
      throw Error("updateUserPosition: previewWithdraw() reverted")
    }
    previewWithdraw0Raw = previewWithdrawRes.value.value0
    previewWithdraw1Raw = previewWithdrawRes.value.value1
  }
  let investorBalanceUnderlying0 = tokenAmountToDecimal(previewWithdraw0Raw, token0.decimals)
  let investorBalanceUnderlying1 = tokenAmountToDecimal(previewWithdraw1Raw, token1.decimals)

  const prices = getVaultPrices(vault, token0, token1)
  const token0PriceInNative = prices.token0ToNative
  const token1PriceInNative = prices.token1ToNative
  const nativePriceUSD = prices.nativeToUsd

  ///////
  // compute derived values
  log.debug("updateUserPosition: computing derived values for vault {}", [vault.id.toHexString()])
  const txGasFeeUSD = tx.gasFee.times(nativePriceUSD)
  const token0PriceInUSD = token0PriceInNative.times(nativePriceUSD)
  const token1PriceInUSD = token1PriceInNative.times(nativePriceUSD)

  ///////
  // update investor positions
  log.debug("updateUserPosition: updating investor position of investor {} for vault {}", [
    investor.id.toHexString(),
    vault.id.toHexString(),
  ])
  const position = getInvestorPosition(vault, investor)
  const previousSharesBalance = position.sharesBalance
  const previousUnderlyingBalance0 = position.underlyingBalance0
  const previousUnderlyingBalance1 = position.underlyingBalance1
  const previousUnderlyingBalance0USD = position.underlyingBalance0USD
  const previousUnderlyingBalance1USD = position.underlyingBalance1USD
  const previousPositionValueUSD = position.positionValueUSD
  const isNewPosition = isNewInvestorPosition(position)
  const isClosingPosition = isDeposit ? false : investorShareTokenBalance.equals(ZERO_BD)
  if (ADDRESS_ZERO.equals(position.createdWith)) {
    position.createdWith = tx.id
  }
  if (isNewPosition) position.positionOpenAtTimestamp = event.block.timestamp
  if (isClosingPosition) {
    position.closedPositionDuration = position.closedPositionDuration.plus(
      event.block.timestamp.minus(position.positionOpenAtTimestamp),
    )
    position.positionOpenAtTimestamp = ZERO_BI
  }
  position.sharesBalance = investorShareTokenBalance
  position.underlyingBalance0 = investorBalanceUnderlying0
  position.underlyingBalance1 = investorBalanceUnderlying1
  position.underlyingBalance0USD = position.underlyingBalance0.times(token0PriceInUSD)
  position.underlyingBalance1USD = position.underlyingBalance1.times(token1PriceInUSD)
  position.positionValueUSD = position.underlyingBalance0USD.plus(position.underlyingBalance1USD)
  const sharesBalanceDelta = position.sharesBalance.minus(previousSharesBalance)
  const underlyingBalance0Delta = position.underlyingBalance0.minus(previousUnderlyingBalance0)
  const underlyingBalance1Delta = position.underlyingBalance1.minus(previousUnderlyingBalance1)
  const underlyingBalance0DeltaUSD = position.underlyingBalance0USD.minus(previousUnderlyingBalance0USD)
  const underlyingBalance1DeltaUSD = position.underlyingBalance1USD.minus(previousUnderlyingBalance1USD)
  const positionValueUSDDelta = position.positionValueUSD.minus(previousPositionValueUSD)
  position.save()
  for (let i = 0; i < periods.length; i++) {
    log.debug("updateUserPosition: updating investor position snapshot of investor {} for vault {} and period {}", [
      investor.id.toHexString(),
      vault.id.toHexString(),
      periods[i].toString(),
    ])
    const positionSnapshot = getInvestorPositionSnapshot(vault, investor, event.block.timestamp, periods[i])
    positionSnapshot.sharesBalance = position.sharesBalance
    positionSnapshot.underlyingBalance0 = position.underlyingBalance0
    positionSnapshot.underlyingBalance1 = position.underlyingBalance1
    positionSnapshot.underlyingBalance0USD = position.underlyingBalance0USD
    positionSnapshot.underlyingBalance1USD = position.underlyingBalance1USD
    positionSnapshot.positionValueUSD = position.positionValueUSD
    positionSnapshot.save()
  }
  let positionInteraction = new InvestorPositionInteraction(getEventIdentifier(event))
  positionInteraction.vault = vault.id
  positionInteraction.investor = investor.id
  positionInteraction.investorPosition = position.id
  positionInteraction.createdWith = tx.id
  positionInteraction.timestamp = event.block.timestamp
  if (isTransfer) positionInteraction.type = "TRANSFER"
  if (!isTransfer && isDeposit) positionInteraction.type = "DEPOSIT"
  if (!isTransfer && !isDeposit) positionInteraction.type = "WITHDRAW"
  positionInteraction.sharesBalance = position.sharesBalance
  positionInteraction.underlyingBalance0 = position.underlyingBalance0
  positionInteraction.underlyingBalance1 = position.underlyingBalance1
  positionInteraction.underlyingBalance0USD = position.underlyingBalance0USD
  positionInteraction.underlyingBalance1USD = position.underlyingBalance1USD
  positionInteraction.positionValueUSD = position.positionValueUSD
  positionInteraction.sharesBalanceDelta = sharesBalanceDelta
  positionInteraction.underlyingBalance0Delta = underlyingBalance0Delta
  positionInteraction.underlyingBalance1Delta = underlyingBalance1Delta
  positionInteraction.underlyingBalance0DeltaUSD = underlyingBalance0DeltaUSD
  positionInteraction.underlyingBalance1DeltaUSD = underlyingBalance1DeltaUSD
  positionInteraction.positionValueUSDDelta = positionValueUSDDelta
  positionInteraction.save()

  ///////
  // update vault entities
  log.debug("updateUserPosition: updating vault entities for vault {}", [vault.id.toHexString()])
  vault.currentPriceOfToken0InToken1 = currentPriceInToken1
  vault.currentPriceOfToken0InUSD = currentPriceInToken1.times(token1PriceInUSD)
  vault.priceRangeMin1 = rangeToken1Price.min
  vault.priceRangeMax1 = rangeToken1Price.max
  vault.priceRangeMinUSD = vault.priceRangeMin1.times(token1PriceInUSD)
  vault.priceRangeMaxUSD = vault.priceRangeMax1.times(token1PriceInUSD)
  vault.underlyingAmount0 = vaultBalanceUnderlying0
  vault.underlyingAmount1 = vaultBalanceUnderlying1
  vault.underlyingAmount0USD = vault.underlyingAmount0.times(token0PriceInUSD)
  vault.underlyingAmount1USD = vault.underlyingAmount1.times(token1PriceInUSD)
  vault.totalValueLockedUSD = vault.underlyingAmount0USD.plus(positionValueUSDDelta)
  if (!isTransfer && isDeposit) vault.cumulativeDepositCount += 1
  if (!isTransfer && !isDeposit) vault.cumulativeWithdrawCount += 1
  vault.save()
  for (let i = 0; i < periods.length; i++) {
    log.debug("updateUserPosition: updating vault snapshot for vault {} and period {}", [
      vault.id.toHexString(),
      periods[i].toString(),
    ])
    const vaultSnapshot = getBeefyCLVaultSnapshot(vault, event.block.timestamp, periods[i])
    vaultSnapshot.currentPriceOfToken0InToken1 = vault.currentPriceOfToken0InToken1
    vaultSnapshot.currentPriceOfToken0InUSD = vault.currentPriceOfToken0InUSD
    vaultSnapshot.priceRangeMin1 = vault.priceRangeMin1
    vaultSnapshot.priceRangeMax1 = vault.priceRangeMax1
    vaultSnapshot.priceRangeMinUSD = vault.priceRangeMinUSD
    vaultSnapshot.priceRangeMaxUSD = vault.priceRangeMaxUSD
    vaultSnapshot.underlyingAmount0 = vault.underlyingAmount0
    vaultSnapshot.underlyingAmount1 = vault.underlyingAmount1
    vaultSnapshot.underlyingAmount0USD = vault.underlyingAmount0USD
    vaultSnapshot.underlyingAmount1USD = vault.underlyingAmount1USD
    vaultSnapshot.totalValueLockedUSD = vault.totalValueLockedUSD
    if (!isTransfer && isDeposit) vaultSnapshot.depositCount += 1
    if (!isTransfer && !isDeposit) vaultSnapshot.withdrawCount += 1
    vaultSnapshot.save()
  }

  ///////
  // update protocol entities
  log.debug("updateUserPosition: updating protocol entities for vault {}", [vault.id.toHexString()])
  const protocol = getBeefyCLProtocol()
  if (!isTransfer || isDeposit) protocol.cumulativeTransactionCount += 1
  if (!isTransfer || isDeposit) protocol.cumulativeInvestorInteractionsCount += 1
  protocol.totalValueLockedUSD = protocol.totalValueLockedUSD.plus(positionValueUSDDelta)
  if (isNewPosition) protocol.activeInvestorCount += 1
  protocol.save()
  for (let i = 0; i < periods.length; i++) {
    log.debug("updateUserPosition: updating protocol snapshot for vault {} and period {}", [
      vault.id.toHexString(),
      periods[i].toString(),
    ])
    const protocolSnapshot = getBeefyCLProtocolSnapshot(event.block.timestamp, periods[i])
    protocolSnapshot.totalValueLockedUSD = protocol.totalValueLockedUSD
    if (newInvestor) protocolSnapshot.newInvestorCount += 1
    if (investor.lastInteractionAt.lt(protocolSnapshot.roundedTimestamp))
      protocolSnapshot.uniqueActiveInvestorCount += 1
    if (!isTransfer || isDeposit) protocolSnapshot.transactionCount += 1
    if (!isTransfer || isDeposit) protocolSnapshot.investorInteractionsCount += 1
    protocolSnapshot.totalGasSpent = protocolSnapshot.totalGasSpent.plus(tx.gasFee)
    protocolSnapshot.totalGasSpentUSD = protocolSnapshot.totalGasSpentUSD.plus(txGasFeeUSD)
    protocolSnapshot.investorGasSpent = protocolSnapshot.investorGasSpent.plus(tx.gasFee)
    protocolSnapshot.investorGasSpentUSD = protocolSnapshot.investorGasSpentUSD.plus(txGasFeeUSD)
    protocolSnapshot.save()
  }

  ///////
  // update investor entities
  log.debug("updateUserPosition: updating investor entities for investor {}", [investor.id.toHexString()])
  if (isNewPosition) investor.activePositionCount += 1
  if (isClosingPosition) investor.activePositionCount -= 1
  const isEnteringTheProtocol = newInvestor || (isNewPosition && investor.activePositionCount === 1)
  if (isEnteringTheProtocol) investor.currentInvestmentOpenAtTimestamp = event.block.timestamp
  const isExitingTheProtocol = investor.activePositionCount > 0
  if (!isExitingTheProtocol) {
    investor.closedInvestmentDuration = investor.closedInvestmentDuration.plus(
      event.block.timestamp.minus(investor.currentInvestmentOpenAtTimestamp),
    )
    investor.currentInvestmentOpenAtTimestamp = ZERO_BI
  }
  investor.lastInteractionAt = event.block.timestamp
  investor.totalPositionValueUSD = investor.totalPositionValueUSD.plus(positionValueUSDDelta)
  investor.cumulativeInteractionsCount += 1
  if (!isTransfer && isDeposit) investor.cumulativeDepositCount += 1
  if (!isTransfer && !isDeposit) investor.cumulativeWithdrawCount += 1
  investor.save()
  for (let i = 0; i < periods.length; i++) {
    log.debug("updateUserPosition: updating investor snapshot for investor {} and period {}", [
      investor.id.toHexString(),
      periods[i].toString(),
    ])
    const investorSnapshot = getInvestorSnapshot(investor, event.block.timestamp, periods[i])
    investorSnapshot.totalPositionValueUSD = investor.totalPositionValueUSD
    investorSnapshot.interactionsCount += 1
    if (!isTransfer && isDeposit) investorSnapshot.depositCount += 1
    if (!isTransfer && !isDeposit) investorSnapshot.withdrawCount += 1
    investorSnapshot.save()
  }
}
