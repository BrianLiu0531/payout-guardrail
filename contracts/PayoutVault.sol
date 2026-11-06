// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title PayoutVault
/// @notice Holds the payout float. The signer's hot key can pay out of it, but only up to a daily
///         limit, only once per intent, and never while paused. Everything else (limit, signer,
///         withdrawals, unpausing) belongs to the owner, which in production is a multisig (for
///         example a Safe). The same idea as Safe's AllowanceModule, kept minimal for this demo.
///         Not audited.
contract PayoutVault {
    IERC20 public immutable token;
    address public owner;
    address public signer;
    uint256 public dailyLimit;
    uint256 public windowStart;
    uint256 public spentInWindow;
    bool public paused;
    mapping(bytes32 => bool) public paid;

    event Paid(bytes32 indexed intentHash, address indexed to, uint256 amount);
    event DailyLimitChanged(uint256 limit);
    event SignerChanged(address signer);
    event PausedChanged(bool paused, address by);
    event OwnershipTransferred(address owner);
    event Withdrawn(address to, uint256 amount);

    error NotOwner();
    error NotSigner();
    error IsPaused();
    error AlreadyPaid();
    error OverDailyLimit(uint256 remaining);
    error TransferFailed();

    constructor(IERC20 token_, address owner_, address signer_, uint256 dailyLimit_) {
        token = token_;
        owner = owner_;
        signer = signer_;
        dailyLimit = dailyLimit_;
        windowStart = block.timestamp;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Pays one approved intent. `intentHash` is the hash the approvers signed.
    function pay(address to, uint256 amount, bytes32 intentHash) external {
        if (msg.sender != signer) revert NotSigner();
        if (paused) revert IsPaused();
        if (paid[intentHash]) revert AlreadyPaid();
        if (block.timestamp >= windowStart + 1 days) {
            windowStart = block.timestamp;
            spentInWindow = 0;
        }
        if (spentInWindow + amount > dailyLimit) revert OverDailyLimit(dailyLimit - spentInWindow);
        spentInWindow += amount;
        paid[intentHash] = true;
        if (!token.transfer(to, amount)) revert TransferFailed();
        emit Paid(intentHash, to, amount);
    }

    /// @notice What the signer could still pay out in the current window.
    function remaining() external view returns (uint256) {
        if (paused) return 0;
        if (block.timestamp >= windowStart + 1 days) return dailyLimit;
        return dailyLimit - spentInWindow;
    }

    /// @notice The signer or the owner can pause (failing safe); only the owner can unpause.
    function pause() external {
        if (msg.sender != signer && msg.sender != owner) revert NotSigner();
        paused = true;
        emit PausedChanged(true, msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit PausedChanged(false, msg.sender);
    }

    function setDailyLimit(uint256 limit) external onlyOwner {
        dailyLimit = limit;
        emit DailyLimitChanged(limit);
    }

    function setSigner(address signer_) external onlyOwner {
        signer = signer_;
        emit SignerChanged(signer_);
    }

    function transferOwnership(address owner_) external onlyOwner {
        owner = owner_;
        emit OwnershipTransferred(owner_);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        if (!token.transfer(to, amount)) revert TransferFailed();
        emit Withdrawn(to, amount);
    }
}
