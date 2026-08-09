// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockVault {
    address public fallbackReceiver = address(0);
    bool public recordRepaymentFailureCalled;

    function repaymentDue(uint256) external pure returns (uint256) {
        return 4020 * 10**6;
    }

    function recordRepaymentFailure(uint256, string calldata) external {
        recordRepaymentFailureCalled = true;
    }

    function settle(uint256, uint256) external pure {
        revert("Settle failed");
    }
}
