// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/// @title MockContractWallet
/// @notice A contract owner answering EIP-1271's isValidSignature, for the control-proof tests
///         (node P8): valid for what its one key signed (`Honest`), or answering each of the ways a
///         contract can fail to say yes.
contract MockContractWallet {
    enum Mode {
        Honest,
        WrongValue,
        Reverts,
        ShortReturn,
        LongReturn,
        DirtyReturn
    }

    bytes4 private constant MAGIC = 0x1626ba7e;
    address public immutable key;
    Mode public mode;

    constructor(address key_, Mode mode_) {
        key = key_;
        mode = mode_;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (mode == Mode.WrongValue) return 0xffffffff;
        if (mode == Mode.Reverts) revert("no");
        if (mode == Mode.ShortReturn) {
            assembly {
                mstore(0, 0x1626ba7e00000000000000000000000000000000000000000000000000000000)
                return(0, 4)
            }
        }
        if (mode == Mode.LongReturn) {
            assembly {
                mstore(0, 0x1626ba7e00000000000000000000000000000000000000000000000000000000)
                return(0, 64)
            }
        }
        if (mode == Mode.DirtyReturn) {
            assembly {
                mstore(0, 0x1626ba7e00000000000000000000000000000000000000000000000000000001)
                return(0, 32)
            }
        }
        if (signature.length != 65) return 0xffffffff;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        return ecrecover(hash, v, r, s) == key ? MAGIC : bytes4(0xffffffff);
    }
}
