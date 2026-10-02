// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
}

/// @title Tabline
/// @notice Merchant-side billing ledger for wallet-granted spending permissions (ERC-7715 / ERC-7710).
///
/// @dev Tabline does NOT custody funds and does NOT enforce the user's spending limits. The user's wallet
///      does that (e.g. MetaMask's `erc20-token-periodic` permission). Tabline adds what a merchant needs
///      on top of that primitive:
///        1. Plans: fixed recurring price, or metered usage with a per-settlement cap.
///        2. Verified settlement: a charge is only recorded if the payout address really received the tokens
///           inside the same transaction (snapshot -> redeem -> settle).
///        3. Idempotency: each charge carries a unique key, so retries can never double-record a charge.
///        4. No surprise catch-up billing: missed periods are skipped, never back-billed.
///        5. Subscriber-side cancel, on top of revoking the permission in the wallet.
///
///      Intended call pattern from the plan's keeper, batched atomically (smart-account user operation):
///          Tabline.snapshot(planId)
///          <token transfer executed on the subscriber's account via the delegation manager>
///          Tabline.settle(planId, subscriber, chargeKey, amount)
///
///      Known limits (documented, not hidden):
///        - The balance-delta check proves the payout address received `amount` in this transaction; it does not
///          prove WHICH account paid. The delegation manager's own redemption event is the source of truth for that.
///        - Only the plan's merchant or keeper may snapshot/settle, otherwise anyone could forge receipts by
///          donating tokens to the payout address.
contract Tabline {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum PlanKind {
        Fixed, // `amount` is the exact price charged once per `period`
        Metered // `amount` is the maximum a single settlement may charge; no schedule
    }

    struct Plan {
        address merchant; // owner of the plan
        address keeper; // operator allowed to snapshot/settle (defaults to merchant)
        address payout; // where redeemed tokens must land
        address token; // ERC-20 being charged
        uint96 amount; // see PlanKind
        uint32 period; // seconds between charges (Fixed only, 0 for Metered)
        PlanKind kind;
        bool active;
    }

    struct Subscription {
        uint48 startedAt;
        uint48 nextDueAt; // Fixed plans only
        bool cancelled;
        uint128 totalPaid;
    }

    struct Snapshot {
        uint256 balance;
        bool set;
    }

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error UnknownPlan();
    error NotMerchant();
    error NotOperator();
    error InvalidParams();
    error PlanInactive();
    error SubscriptionCancelled();
    error AlreadySettled();
    error WrongAmount();
    error NotDue(uint48 nextDueAt);
    error NoSnapshot();
    error PaymentNotReceived();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event PlanCreated(
        uint256 indexed planId,
        address indexed merchant,
        address token,
        address payout,
        address keeper,
        uint96 amount,
        uint32 period,
        PlanKind kind
    );
    event PayoutChanged(uint256 indexed planId, address payout);
    event KeeperChanged(uint256 indexed planId, address keeper);
    event PlanActiveChanged(uint256 indexed planId, bool active);
    event Charged(
        uint256 indexed planId,
        address indexed subscriber,
        bytes32 indexed chargeKey,
        uint256 amount,
        uint48 nextDueAt
    );
    event Cancelled(uint256 indexed planId, address indexed subscriber);
    event Resumed(uint256 indexed planId, address indexed subscriber);

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    uint32 public constant MIN_PERIOD = 60 seconds;

    uint256 public planCount;
    mapping(uint256 planId => Plan) public plans;
    mapping(uint256 planId => mapping(address subscriber => Subscription)) public subscriptions;
    mapping(bytes32 id => bool) public settled;
    mapping(address operator => mapping(uint256 planId => Snapshot)) private _snapshots;

    // ---------------------------------------------------------------------
    // Merchant: plan management
    // ---------------------------------------------------------------------

    /// @param keeper Operator allowed to snapshot/settle. Pass address(0) to use the caller.
    function createPlan(address token, address payout, address keeper, uint96 amount, uint32 period, PlanKind kind)
        external
        returns (uint256 planId)
    {
        if (token == address(0) || payout == address(0) || amount == 0) revert InvalidParams();
        if (kind == PlanKind.Fixed) {
            if (period < MIN_PERIOD) revert InvalidParams();
        } else if (period != 0) {
            revert InvalidParams();
        }

        address operator = keeper == address(0) ? msg.sender : keeper;
        planId = ++planCount;
        plans[planId] = Plan({
            merchant: msg.sender,
            keeper: operator,
            payout: payout,
            token: token,
            amount: amount,
            period: period,
            kind: kind,
            active: true
        });

        emit PlanCreated(planId, msg.sender, token, payout, operator, amount, period, kind);
    }

    function setPayout(uint256 planId, address payout) external {
        Plan storage p = _merchantPlan(planId);
        if (payout == address(0)) revert InvalidParams();
        p.payout = payout;
        emit PayoutChanged(planId, payout);
    }

    function setKeeper(uint256 planId, address keeper) external {
        Plan storage p = _merchantPlan(planId);
        if (keeper == address(0)) revert InvalidParams();
        p.keeper = keeper;
        emit KeeperChanged(planId, keeper);
    }

    function setActive(uint256 planId, bool active) external {
        Plan storage p = _merchantPlan(planId);
        p.active = active;
        emit PlanActiveChanged(planId, active);
    }

    // ---------------------------------------------------------------------
    // Operator: snapshot + settle
    // ---------------------------------------------------------------------

    /// @notice Record the payout address's current token balance. Must be followed by `settle` in the same tx.
    function snapshot(uint256 planId) external {
        Plan storage p = _plan(planId);
        _requireOperator(p);
        _snapshots[msg.sender][planId] = Snapshot({balance: IERC20Balance(p.token).balanceOf(p.payout), set: true});
    }

    /// @notice Record a charge after verifying `amount` tokens arrived at the payout address since `snapshot`.
    /// @param chargeKey Idempotency key. Fixed plans: e.g. hash of the billing period. Metered: e.g. a usage batch id.
    function settle(uint256 planId, address subscriber, bytes32 chargeKey, uint256 amount) external {
        Plan storage p = _plan(planId);
        _requireOperator(p);
        if (!p.active) revert PlanInactive();

        Subscription storage s = subscriptions[planId][subscriber];
        if (s.cancelled) revert SubscriptionCancelled();

        bytes32 id = keccak256(abi.encode(planId, subscriber, chargeKey));
        if (settled[id]) revert AlreadySettled();

        if (p.kind == PlanKind.Fixed) {
            if (amount != p.amount) revert WrongAmount();
            if (s.startedAt == 0) {
                s.startedAt = uint48(block.timestamp);
                s.nextDueAt = uint48(block.timestamp);
            }
            if (block.timestamp < s.nextDueAt) revert NotDue(s.nextDueAt);

            // Advance one period. If the merchant was down for longer, skip missed periods instead of back-billing.
            uint256 next = uint256(s.nextDueAt) + p.period;
            if (next <= block.timestamp) next = block.timestamp + p.period;
            s.nextDueAt = uint48(next);
        } else {
            if (amount == 0 || amount > p.amount) revert WrongAmount();
            if (s.startedAt == 0) s.startedAt = uint48(block.timestamp);
        }

        Snapshot memory snap = _snapshots[msg.sender][planId];
        if (!snap.set) revert NoSnapshot();
        delete _snapshots[msg.sender][planId];

        uint256 balanceNow = IERC20Balance(p.token).balanceOf(p.payout);
        if (balanceNow < snap.balance || balanceNow - snap.balance < amount) revert PaymentNotReceived();

        settled[id] = true;
        s.totalPaid += uint128(amount);

        emit Charged(planId, subscriber, chargeKey, amount, s.nextDueAt);
    }

    // ---------------------------------------------------------------------
    // Subscriber: cancel / resume
    // ---------------------------------------------------------------------

    /// @notice Stop all future charges on this plan for msg.sender. Revoke the wallet permission as well.
    function cancel(uint256 planId) external {
        _plan(planId);
        subscriptions[planId][msg.sender].cancelled = true;
        emit Cancelled(planId, msg.sender);
    }

    function resume(uint256 planId) external {
        _plan(planId);
        subscriptions[planId][msg.sender].cancelled = false;
        emit Resumed(planId, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice True if a Fixed plan is chargeable right now for `subscriber`. Always false for Metered plans.
    function isDue(uint256 planId, address subscriber) external view returns (bool) {
        Plan storage p = plans[planId];
        if (p.merchant == address(0) || !p.active || p.kind != PlanKind.Fixed) return false;
        Subscription storage s = subscriptions[planId][subscriber];
        if (s.cancelled) return false;
        return s.startedAt == 0 || block.timestamp >= s.nextDueAt;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _plan(uint256 planId) private view returns (Plan storage p) {
        p = plans[planId];
        if (p.merchant == address(0)) revert UnknownPlan();
    }

    function _merchantPlan(uint256 planId) private view returns (Plan storage p) {
        p = _plan(planId);
        if (msg.sender != p.merchant) revert NotMerchant();
    }

    function _requireOperator(Plan storage p) private view {
        if (msg.sender != p.merchant && msg.sender != p.keeper) revert NotOperator();
    }
}
