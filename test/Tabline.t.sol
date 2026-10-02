// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Tabline} from "../src/Tabline.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract TablineTest is Test {
    Tabline internal tabline;
    MockUSDC internal usdc;

    address internal merchant = makeAddr("merchant");
    address internal keeper = makeAddr("keeper");
    address internal payout = makeAddr("payout");
    address internal alice = makeAddr("alice"); // subscriber
    address internal bob = makeAddr("bob"); // subscriber
    address internal attacker = makeAddr("attacker");

    uint96 internal constant PRICE = 10e6; // 10 USDC
    uint32 internal constant PERIOD = 30 days;
    uint96 internal constant CAP = 5e6; // metered cap per settlement

    uint256 internal fixedPlan;
    uint256 internal meteredPlan;

    function setUp() public {
        tabline = new Tabline();
        usdc = new MockUSDC();

        vm.startPrank(merchant);
        fixedPlan = tabline.createPlan(address(usdc), payout, keeper, PRICE, PERIOD, Tabline.PlanKind.Fixed);
        meteredPlan = tabline.createPlan(address(usdc), payout, keeper, CAP, 0, Tabline.PlanKind.Metered);
        vm.stopPrank();

        usdc.mint(alice, 1_000e6);
        usdc.mint(bob, 1_000e6);
    }

    // -- helpers ---------------------------------------------------------

    /// Simulates the atomic keeper batch: snapshot -> (delegated transfer from subscriber) -> settle.
    function _charge(uint256 planId, address subscriber, bytes32 key, uint256 amount) internal {
        vm.startPrank(keeper);
        tabline.snapshot(planId);
        vm.stopPrank();

        // In production this is executed on the subscriber's account by the delegation manager.
        vm.prank(subscriber);
        usdc.transfer(payout, amount);

        vm.prank(keeper);
        tabline.settle(planId, subscriber, key, amount);
    }

    // -- plan creation ---------------------------------------------------

    function test_createPlan_fixed() public view {
        (address m, address k, address p, address t, uint96 a, uint32 per, Tabline.PlanKind kind, bool active) =
            tabline.plans(fixedPlan);
        assertEq(m, merchant);
        assertEq(k, keeper);
        assertEq(p, payout);
        assertEq(t, address(usdc));
        assertEq(a, PRICE);
        assertEq(per, PERIOD);
        assertTrue(kind == Tabline.PlanKind.Fixed);
        assertTrue(active);
        assertEq(tabline.planCount(), 2);
    }

    function test_createPlan_keeperDefaultsToCaller() public {
        vm.prank(merchant);
        uint256 id = tabline.createPlan(address(usdc), payout, address(0), PRICE, PERIOD, Tabline.PlanKind.Fixed);
        (, address k,,,,,,) = tabline.plans(id);
        assertEq(k, merchant);
    }

    function test_createPlan_revertsOnBadParams() public {
        vm.startPrank(merchant);
        vm.expectRevert(Tabline.InvalidParams.selector);
        tabline.createPlan(address(0), payout, keeper, PRICE, PERIOD, Tabline.PlanKind.Fixed);
        vm.expectRevert(Tabline.InvalidParams.selector);
        tabline.createPlan(address(usdc), address(0), keeper, PRICE, PERIOD, Tabline.PlanKind.Fixed);
        vm.expectRevert(Tabline.InvalidParams.selector);
        tabline.createPlan(address(usdc), payout, keeper, 0, PERIOD, Tabline.PlanKind.Fixed);
        vm.expectRevert(Tabline.InvalidParams.selector);
        tabline.createPlan(address(usdc), payout, keeper, PRICE, 59, Tabline.PlanKind.Fixed); // below MIN_PERIOD
        vm.expectRevert(Tabline.InvalidParams.selector);
        tabline.createPlan(address(usdc), payout, keeper, PRICE, 1 days, Tabline.PlanKind.Metered); // metered has no period
        vm.stopPrank();
    }

    function test_onlyMerchantCanEditPlan() public {
        vm.startPrank(attacker);
        vm.expectRevert(Tabline.NotMerchant.selector);
        tabline.setPayout(fixedPlan, attacker);
        vm.expectRevert(Tabline.NotMerchant.selector);
        tabline.setKeeper(fixedPlan, attacker);
        vm.expectRevert(Tabline.NotMerchant.selector);
        tabline.setActive(fixedPlan, false);
        vm.stopPrank();
    }

    function test_unknownPlanReverts() public {
        vm.expectRevert(Tabline.UnknownPlan.selector);
        tabline.setActive(999, false);
        vm.expectRevert(Tabline.UnknownPlan.selector);
        tabline.cancel(999);
    }

    // -- fixed plans -----------------------------------------------------

    function test_fixed_firstChargeHappyPath() public {
        assertTrue(tabline.isDue(fixedPlan, alice));

        vm.prank(keeper);
        tabline.snapshot(fixedPlan);
        vm.prank(alice);
        usdc.transfer(payout, PRICE);

        // Arm the event check immediately before settle (the token transfer above emits its own log).
        vm.expectEmit(true, true, true, true, address(tabline));
        emit Tabline.Charged(fixedPlan, alice, keccak256("p1"), PRICE, uint48(block.timestamp + PERIOD));
        vm.prank(keeper);
        tabline.settle(fixedPlan, alice, keccak256("p1"), PRICE);

        (uint48 startedAt, uint48 nextDueAt, bool cancelled, uint128 totalPaid) = tabline.subscriptions(fixedPlan, alice);
        assertEq(startedAt, block.timestamp);
        assertEq(nextDueAt, block.timestamp + PERIOD);
        assertFalse(cancelled);
        assertEq(totalPaid, PRICE);
        assertEq(usdc.balanceOf(payout), PRICE);
        assertFalse(tabline.isDue(fixedPlan, alice));
    }

    function test_fixed_notDueUntilPeriodElapses() public {
        _charge(fixedPlan, alice, keccak256("p1"), PRICE);
        uint48 due = uint48(block.timestamp + PERIOD);

        vm.prank(keeper);
        tabline.snapshot(fixedPlan);
        vm.prank(alice);
        usdc.transfer(payout, PRICE);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Tabline.NotDue.selector, due));
        tabline.settle(fixedPlan, alice, keccak256("p2"), PRICE);

        vm.warp(due);
        assertTrue(tabline.isDue(fixedPlan, alice));
    }

    function test_fixed_secondPeriodCharges() public {
        _charge(fixedPlan, alice, keccak256("p1"), PRICE);
        vm.warp(block.timestamp + PERIOD);
        _charge(fixedPlan, alice, keccak256("p2"), PRICE);

        (,,, uint128 totalPaid) = tabline.subscriptions(fixedPlan, alice);
        assertEq(totalPaid, 2 * uint128(PRICE));
    }

    function test_fixed_skipsMissedPeriodsInsteadOfBackBilling() public {
        _charge(fixedPlan, alice, keccak256("p1"), PRICE);

        // Merchant is down for 5 periods.
        vm.warp(block.timestamp + 5 * uint256(PERIOD));
        _charge(fixedPlan, alice, keccak256("p6"), PRICE);

        // Exactly one charge went through, and the next due date is a full period from NOW, not from the past.
        (, uint48 nextDueAt,,) = tabline.subscriptions(fixedPlan, alice);
        assertEq(nextDueAt, block.timestamp + PERIOD);
        assertFalse(tabline.isDue(fixedPlan, alice));

        // A second immediate charge (back-billing attempt) is rejected.
        vm.prank(keeper);
        tabline.snapshot(fixedPlan);
        vm.prank(alice);
        usdc.transfer(payout, PRICE);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Tabline.NotDue.selector, nextDueAt));
        tabline.settle(fixedPlan, alice, keccak256("p7"), PRICE);
    }

    function test_fixed_subscribersAreIndependent() public {
        _charge(fixedPlan, alice, keccak256("p1"), PRICE);
        assertTrue(tabline.isDue(fixedPlan, bob));
        _charge(fixedPlan, bob, keccak256("p1"), PRICE); // same key, different subscriber: allowed
        assertEq(usdc.balanceOf(payout), 2 * uint256(PRICE));
    }

    function test_fixed_wrongAmountReverts() public {
        vm.prank(keeper);
        tabline.snapshot(fixedPlan);
        vm.prank(alice);
        usdc.transfer(payout, PRICE + 1);
        vm.prank(keeper);
        vm.expectRevert(Tabline.WrongAmount.selector);
        tabline.settle(fixedPlan, alice, keccak256("p1"), PRICE + 1);
    }

    // -- verification and idempotency -----------------------------------

    function test_settle_revertsWithoutSnapshot() public {
        vm.prank(alice);
        usdc.transfer(payout, PRICE);
        vm.prank(keeper);
        vm.expectRevert(Tabline.NoSnapshot.selector);
        tabline.settle(fixedPlan, alice, keccak256("p1"), PRICE);
    }

    function test_settle_snapshotIsConsumed() public {
        _charge(meteredPlan, alice, keccak256("u1"), 1e6);

        // No fresh snapshot: a second settle cannot reuse the old one.
        vm.prank(alice);
        usdc.transfer(payout, 1e6);
        vm.prank(keeper);
        vm.expectRevert(Tabline.NoSnapshot.selector);
        tabline.settle(meteredPlan, alice, keccak256("u2"), 1e6);
    }

    function test_settle_revertsWhenPaymentNotReceived() public {
        vm.prank(keeper);
        tabline.snapshot(fixedPlan);
        // No transfer happens.
        vm.prank(keeper);
        vm.expectRevert(Tabline.PaymentNotReceived.selector);
        tabline.settle(fixedPlan, alice, keccak256("p1"), PRICE);
    }

    function test_settle_revertsWhenPaymentShort() public {
        vm.prank(keeper);
        tabline.snapshot(fixedPlan);
        vm.prank(alice);
        usdc.transfer(payout, PRICE - 1);
        vm.prank(keeper);
        vm.expectRevert(Tabline.PaymentNotReceived.selector);
        tabline.settle(fixedPlan, alice, keccak256("p1"), PRICE);
    }

    function test_settle_priorBalanceDoesNotCount() public {
        // Payout already holds plenty before the snapshot; only the delta since snapshot may count.
        usdc.mint(payout, 1_000e6);
        vm.prank(keeper);
        tabline.snapshot(fixedPlan);
        vm.prank(keeper);
        vm.expectRevert(Tabline.PaymentNotReceived.selector);
        tabline.settle(fixedPlan, alice, keccak256("p1"), PRICE);
    }

    function test_settle_duplicateChargeKeyReverts() public {
        _charge(meteredPlan, alice, keccak256("u1"), 1e6);

        vm.prank(keeper);
        tabline.snapshot(meteredPlan);
        vm.prank(alice);
        usdc.transfer(payout, 1e6);
        vm.prank(keeper);
        vm.expectRevert(Tabline.AlreadySettled.selector);
        tabline.settle(meteredPlan, alice, keccak256("u1"), 1e6);
    }

    // -- access control --------------------------------------------------

    function test_nonOperatorCannotSnapshotOrSettle() public {
        vm.startPrank(attacker);
        vm.expectRevert(Tabline.NotOperator.selector);
        tabline.snapshot(fixedPlan);
        vm.expectRevert(Tabline.NotOperator.selector);
        tabline.settle(fixedPlan, alice, keccak256("p1"), PRICE);
        vm.stopPrank();
    }

    function test_snapshotsAreScopedPerOperator() public {
        // Merchant snapshots, but the keeper is the one who settles: must not borrow the merchant's snapshot.
        vm.prank(merchant);
        tabline.snapshot(fixedPlan);
        vm.prank(alice);
        usdc.transfer(payout, PRICE);
        vm.prank(keeper);
        vm.expectRevert(Tabline.NoSnapshot.selector);
        tabline.settle(fixedPlan, alice, keccak256("p1"), PRICE);
    }

    function test_donationCannotForgeReceiptForNonOperator() public {
        // An attacker funds the payout address hoping to forge a receipt against alice: they cannot call settle at all.
        vm.startPrank(attacker);
        vm.expectRevert(Tabline.NotOperator.selector);
        tabline.snapshot(fixedPlan);
        vm.stopPrank();
    }

    // -- cancel / active flags ------------------------------------------

    function test_subscriberCancelBlocksChargesAndResumeRestores() public {
        vm.prank(alice);
        tabline.cancel(fixedPlan);
        assertFalse(tabline.isDue(fixedPlan, alice));

        vm.prank(keeper);
        tabline.snapshot(fixedPlan);
        vm.prank(alice);
        usdc.transfer(payout, PRICE);
        vm.prank(keeper);
        vm.expectRevert(Tabline.SubscriptionCancelled.selector);
        tabline.settle(fixedPlan, alice, keccak256("p1"), PRICE);

        // Cancelling only affects the caller.
        assertTrue(tabline.isDue(fixedPlan, bob));

        vm.prank(alice);
        tabline.resume(fixedPlan);
        assertTrue(tabline.isDue(fixedPlan, alice));
    }

    function test_inactivePlanBlocksCharges() public {
        vm.prank(merchant);
        tabline.setActive(fixedPlan, false);
        assertFalse(tabline.isDue(fixedPlan, alice));

        vm.prank(keeper);
        tabline.snapshot(fixedPlan);
        vm.prank(alice);
        usdc.transfer(payout, PRICE);
        vm.prank(keeper);
        vm.expectRevert(Tabline.PlanInactive.selector);
        tabline.settle(fixedPlan, alice, keccak256("p1"), PRICE);
    }

    function test_merchantCanRotateKeeper() public {
        address newKeeper = makeAddr("newKeeper");
        vm.prank(merchant);
        tabline.setKeeper(fixedPlan, newKeeper);

        vm.prank(keeper);
        vm.expectRevert(Tabline.NotOperator.selector);
        tabline.snapshot(fixedPlan);

        vm.prank(newKeeper);
        tabline.snapshot(fixedPlan);
    }

    // -- metered plans ---------------------------------------------------

    function test_metered_multipleSettlementsAccumulate() public {
        _charge(meteredPlan, alice, keccak256("u1"), 2e6);
        _charge(meteredPlan, alice, keccak256("u2"), 3e6);
        _charge(meteredPlan, alice, keccak256("u3"), CAP);

        (,,, uint128 totalPaid) = tabline.subscriptions(meteredPlan, alice);
        assertEq(totalPaid, 10e6);
        assertFalse(tabline.isDue(meteredPlan, alice)); // metered plans have no schedule
    }

    function test_metered_overCapReverts() public {
        vm.prank(keeper);
        tabline.snapshot(meteredPlan);
        vm.prank(alice);
        usdc.transfer(payout, uint256(CAP) + 1);
        vm.prank(keeper);
        vm.expectRevert(Tabline.WrongAmount.selector);
        tabline.settle(meteredPlan, alice, keccak256("u1"), uint256(CAP) + 1);
    }

    function test_metered_zeroAmountReverts() public {
        vm.prank(keeper);
        tabline.snapshot(meteredPlan);
        vm.prank(keeper);
        vm.expectRevert(Tabline.WrongAmount.selector);
        tabline.settle(meteredPlan, alice, keccak256("u1"), 0);
    }

    // -- fuzz ------------------------------------------------------------

    function testFuzz_metered_withinCapAlwaysSettles(uint96 amount, bytes32 key) public {
        amount = uint96(bound(amount, 1, CAP));
        _charge(meteredPlan, alice, key, amount);
        (,,, uint128 totalPaid) = tabline.subscriptions(meteredPlan, alice);
        assertEq(totalPaid, amount);
    }

    function testFuzz_metered_overCapAlwaysReverts(uint96 amount) public {
        amount = uint96(bound(amount, uint256(CAP) + 1, type(uint96).max));
        vm.prank(keeper);
        tabline.snapshot(meteredPlan);
        vm.prank(keeper);
        vm.expectRevert(Tabline.WrongAmount.selector);
        tabline.settle(meteredPlan, alice, keccak256("x"), amount);
    }

    function testFuzz_fixed_neverChargedTwiceInOnePeriod(uint32 elapsed) public {
        elapsed = uint32(bound(elapsed, 0, PERIOD - 1));
        _charge(fixedPlan, alice, keccak256("p1"), PRICE);
        vm.warp(block.timestamp + elapsed);

        vm.prank(keeper);
        tabline.snapshot(fixedPlan);
        vm.prank(alice);
        usdc.transfer(payout, PRICE);
        vm.prank(keeper);
        vm.expectRevert();
        tabline.settle(fixedPlan, alice, keccak256("p2"), PRICE);
    }
}
