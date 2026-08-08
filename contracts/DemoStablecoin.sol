// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title DemoStablecoin
 * @notice A plain, unrestricted ERC-20 standing in for USDC so the bridge
 *         advance has something real to pay out.
 *
 * NOT PART OF THE PRODUCT. On any network where a real stablecoin exists, pass
 * that address to BridgeAdvanceVault and never deploy this. It carries an owner
 * mint solely so a demo can seed vault liquidity without a faucet.
 */
contract DemoStablecoin is ERC20, Ownable {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address owner_)
        ERC20(name_, symbol_)
        Ownable(owner_)
    {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
