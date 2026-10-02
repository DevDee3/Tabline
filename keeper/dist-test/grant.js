"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiError = void 0;
exports.parseGrant = parseGrant;
const viem_1 = require("viem");
class ApiError extends Error {
    status;
    code;
    extra;
    constructor(status, code, message, extra = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}
exports.ApiError = ApiError;
const num = (v, name) => {
    try {
        if (typeof v === "bigint")
            return v;
        if (typeof v === "number")
            return BigInt(v);
        if (typeof v === "string" && v.length > 0)
            return BigInt(v); // handles "123" and "0x7b"
    }
    catch {
        /* fallthrough */
    }
    throw new ApiError(400, "invalid_grant", `grant field ${name} is not a number`);
};
const addr = (v, name) => {
    if (typeof v !== "string" || !(0, viem_1.isAddress)(v))
        throw new ApiError(400, "invalid_grant", `grant field ${name} is not an address`);
    return (0, viem_1.getAddress)(v);
};
/**
 * Validates an ERC-7715 permission response against the plan and normalizes it. The wallet returns the raw
 * permission; this rejects anything the keeper could not or should not redeem.
 */
function parseGrant(input, ctx) {
    const list = Array.isArray(input) ? input : [input];
    const raw = list.find((g) => g && typeof g === "object" && Number(num(g.chainId, "chainId")) === ctx.chainId);
    if (!raw)
        throw new ApiError(400, "invalid_grant", `no permission for chain ${ctx.chainId} in the request`);
    const context = raw.context;
    if (!(0, viem_1.isHex)(context) || context.length < 4)
        throw new ApiError(400, "invalid_grant", "grant.context missing");
    const delegationManager = addr(raw.delegationManager, "delegationManager");
    const perm = raw.permission;
    if (!perm || perm.type !== "erc20-token-periodic") {
        throw new ApiError(400, "unsupported_permission", "only erc20-token-periodic permissions are supported");
    }
    const tokenAddress = addr(perm.data?.tokenAddress, "permission.data.tokenAddress");
    const periodAmount = num(perm.data?.periodAmount, "periodAmount");
    const periodDuration = Number(num(perm.data?.periodDuration, "periodDuration"));
    const to = addr(raw.to, "to");
    if (to.toLowerCase() !== ctx.keeper.toLowerCase()) {
        throw new ApiError(400, "wrong_delegate", `permission must be granted to the keeper ${ctx.keeper}`);
    }
    const from = raw.from ? addr(raw.from, "from") : ctx.subscriber;
    if (from.toLowerCase() !== ctx.subscriber.toLowerCase()) {
        throw new ApiError(400, "wrong_subscriber", "permission was granted by a different account");
    }
    const expiryRule = Array.isArray(raw.rules) ? raw.rules.find((r) => r?.type === "expiry") : undefined;
    if (!expiryRule)
        throw new ApiError(400, "no_expiry", "permission has no expiry; Tabline refuses open-ended permissions");
    const expiry = Number(num(expiryRule.data?.timestamp, "expiry"));
    if (expiry <= ctx.now + 3600)
        throw new ApiError(400, "expiry_too_soon", "permission expires in under an hour");
    if (tokenAddress.toLowerCase() !== ctx.plan.token.toLowerCase()) {
        throw new ApiError(400, "wrong_token", "permission token does not match the plan token");
    }
    if (periodAmount < ctx.plan.amount) {
        throw new ApiError(400, "limit_too_low", "permission limit per period is lower than the plan amount", {
            required: ctx.plan.amount.toString(),
            granted: periodAmount.toString(),
        });
    }
    if (ctx.plan.kind === "fixed" && periodDuration > ctx.plan.period) {
        throw new ApiError(400, "period_too_long", "permission period is longer than the plan billing period");
    }
    if (periodDuration <= 0)
        throw new ApiError(400, "invalid_grant", "periodDuration must be positive");
    return {
        context: context,
        delegationManager,
        chainId: ctx.chainId,
        from,
        to,
        tokenAddress,
        periodAmount: periodAmount.toString(),
        periodDuration,
        expiry,
    };
}
