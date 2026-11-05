// Generated from contracts/MockUSDC.sol with solc 0.8.28+commit.7893614a.Emscripten.clang (optimizer, 200 runs). Do not edit.
export const mockUsdcAbi = [
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "owner",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "spender",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "value",
        "type": "uint256"
      }
    ],
    "name": "Approval",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "from",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "value",
        "type": "uint256"
      }
    ],
    "name": "Transfer",
    "type": "event"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "allowance",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "spender",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "value",
        "type": "uint256"
      }
    ],
    "name": "approve",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "balanceOf",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "decimals",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "value",
        "type": "uint256"
      }
    ],
    "name": "mint",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "name",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "symbol",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "totalSupply",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "value",
        "type": "uint256"
      }
    ],
    "name": "transfer",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "from",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "value",
        "type": "uint256"
      }
    ],
    "name": "transferFrom",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;

export const mockUsdcBytecode = '0x6080604052348015600e575f5ffd5b506106478061001c5f395ff3fe608060405234801561000f575f5ffd5b506004361061009b575f3560e01c806340c10f191161006357806340c10f191461014757806370a082311461015c57806395d89b411461017b578063a9059cbb1461019f578063dd62ed3e146101b2575f5ffd5b806306fdde031461009f578063095ea7b3146100e157806318160ddd1461010457806323b872dd1461011a578063313ce5671461012d575b5f5ffd5b6100cb6040518060400160405280600d81526020016c26b7b1b5902aa9a21021b7b4b760991b81525081565b6040516100d891906104d4565b60405180910390f35b6100f46100ef366004610524565b6101dc565b60405190151581526020016100d8565b61010c5f5481565b6040519081526020016100d8565b6100f461012836600461054c565b610248565b610135600681565b60405160ff90911681526020016100d8565b61015a610155366004610524565b6102f8565b005b61010c61016a366004610586565b60016020525f908152604090205481565b6100cb604051806040016040528060058152602001646d5553444360d81b81525081565b6100f46101ad366004610524565b61037d565b61010c6101c03660046105a6565b600260209081525f928352604080842090915290825290205481565b335f8181526002602090815260408083206001600160a01b038716808552925280832085905551919290917f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925906102369086815260200190565b60405180910390a35060015b92915050565b6001600160a01b0383165f908152600260209081526040808320338452909152812054828110156102ac5760405162461bcd60e51b8152602060048201526009602482015268616c6c6f77616e636560b81b60448201526064015b60405180910390fd5b5f1981146102e2576102be83826105eb565b6001600160a01b0386165f9081526002602090815260408083203384529091529020555b6102ed858585610392565b506001949350505050565b805f5f82825461030891906105fe565b90915550506001600160a01b0382165f90815260016020526040812080548392906103349084906105fe565b90915550506040518181526001600160a01b038316905f907fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9060200160405180910390a35050565b5f610389338484610392565b50600192915050565b6001600160a01b0382166103d75760405162461bcd60e51b815260206004820152600c60248201526b7a65726f206164647265737360a01b60448201526064016102a3565b6001600160a01b0383165f908152600160205260409020548111156104285760405162461bcd60e51b815260206004820152600760248201526662616c616e636560c81b60448201526064016102a3565b6001600160a01b0383165f908152600160205260408120805483929061044f9084906105eb565b90915550506001600160a01b0382165f908152600160205260408120805483929061047b9084906105fe565b92505081905550816001600160a01b0316836001600160a01b03167fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef836040516104c791815260200190565b60405180910390a3505050565b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f83011684010191505092915050565b80356001600160a01b038116811461051f575f5ffd5b919050565b5f5f60408385031215610535575f5ffd5b61053e83610509565b946020939093013593505050565b5f5f5f6060848603121561055e575f5ffd5b61056784610509565b925061057560208501610509565b929592945050506040919091013590565b5f60208284031215610596575f5ffd5b61059f82610509565b9392505050565b5f5f604083850312156105b7575f5ffd5b6105c083610509565b91506105ce60208401610509565b90509250929050565b634e487b7160e01b5f52601160045260245ffd5b81810381811115610242576102426105d7565b80820180821115610242576102426105d756fea2646970667358221220d6bbd4206d1a3300f642719c31f9b3805f362f5391bcca76f80b34f41870a39764736f6c634300081c0033' as const;
