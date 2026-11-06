// Generated from contracts/PayoutVault.sol with solc 0.8.28+commit.7893614a.Emscripten.clang (optimizer, 200 runs). Do not edit.
export const payoutVaultAbi = [
  {
    "inputs": [
      {
        "internalType": "contract IERC20",
        "name": "token_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "owner_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "signer_",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "dailyLimit_",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "AlreadyPaid",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "IsPaused",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotOwner",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotSigner",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "remaining",
        "type": "uint256"
      }
    ],
    "name": "OverDailyLimit",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TransferFailed",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "limit",
        "type": "uint256"
      }
    ],
    "name": "DailyLimitChanged",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "address",
        "name": "owner",
        "type": "address"
      }
    ],
    "name": "OwnershipTransferred",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "intentHash",
        "type": "bytes32"
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
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "Paid",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "bool",
        "name": "paused",
        "type": "bool"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "by",
        "type": "address"
      }
    ],
    "name": "PausedChanged",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "address",
        "name": "signer",
        "type": "address"
      }
    ],
    "name": "SignerChanged",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "Withdrawn",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "dailyLimit",
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
    "name": "owner",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "name": "paid",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "pause",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "paused",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
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
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "bytes32",
        "name": "intentHash",
        "type": "bytes32"
      }
    ],
    "name": "pay",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "remaining",
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
        "internalType": "uint256",
        "name": "limit",
        "type": "uint256"
      }
    ],
    "name": "setDailyLimit",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "signer_",
        "type": "address"
      }
    ],
    "name": "setSigner",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "signer",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "spentInWindow",
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
    "name": "token",
    "outputs": [
      {
        "internalType": "contract IERC20",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "owner_",
        "type": "address"
      }
    ],
    "name": "transferOwnership",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "unpause",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "windowStart",
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
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "withdraw",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;

export const payoutVaultBytecode = '0x60a060405234801561000f575f5ffd5b50604051610a3c380380610a3c83398101604081905261002e91610084565b6001600160a01b039384166080525f80549385166001600160a01b031994851617905560018054929094169190921617909155600255426003556100d4565b6001600160a01b0381168114610081575f5ffd5b50565b5f5f5f5f60808587031215610097575f5ffd5b84516100a28161006d565b60208601519094506100b38161006d565b60408601519093506100c48161006d565b6060959095015193969295505050565b6080516109426100fa5f395f818161022701528181610439015261073601526109425ff3fe608060405234801561000f575f5ffd5b50600436106100fb575f3560e01c80638da5cb5b11610093578063db1f237f11610063578063db1f237f146101f3578063f2fde38b146101fc578063f3fef3a31461020f578063fc0c546a14610222575f5ffd5b80638da5cb5b146101a3578063add89bb2146101b5578063b0c2783a146101d7578063b20d30a9146101e0575f5ffd5b80635e5571ac116100ce5780635e5571ac1461016c57806367eeba0c1461017f5780636c19e783146101885780638456cb591461019b575f5ffd5b8063238ac933146100ff5780633f4ba83a1461012f57806355234ec0146101395780635c975abb1461014f575b5f5ffd5b600154610112906001600160a01b031681565b6040516001600160a01b0390911681526020015b60405180910390f35b610137610249565b005b6101416102b8565b604051908152602001610126565b60055461015c9060ff1681565b6040519015158152602001610126565b61013761017a36600461081e565b6102fc565b61014160025481565b61013761019636600461084e565b610509565b610137610588565b5f54610112906001600160a01b031681565b61015c6101c336600461086e565b60066020525f908152604090205460ff1681565b61014160035481565b6101376101ee36600461086e565b610610565b61014160045481565b61013761020a36600461084e565b61066f565b61013761021d366004610885565b6106e6565b6101127f000000000000000000000000000000000000000000000000000000000000000081565b5f546001600160a01b03163314610273576040516330cd747160e01b815260040160405180910390fd5b6005805460ff19169055604080515f81523360208201527f5030d20e55e366dbc928d61e3b8a2322c5f28d5a605ce4246465849bd80bc86d91015b60405180910390a1565b6005545f9060ff16156102ca57505f90565b6003546102da90620151806108c1565b42106102e7575060025490565b6004546002546102f791906108da565b905090565b6001546001600160a01b031633146103275760405163143606b960e31b815260040160405180910390fd5b60055460ff161561034b57604051631309a56360e01b815260040160405180910390fd5b5f8181526006602052604090205460ff161561037a57604051630d70a0e360e41b815260040160405180910390fd5b60035461038a90620151806108c1565b421061039957426003555f6004555b600254826004546103aa91906108c1565b11156103e5576004546002546103c091906108da565b604051633422b3bd60e11b81526004016103dc91815260200190565b60405180910390fd5b8160045f8282546103f691906108c1565b90915550505f8181526006602052604090819020805460ff191660011790555163a9059cbb60e01b81526001600160a01b038481166004830152602482018490527f0000000000000000000000000000000000000000000000000000000000000000169063a9059cbb906044016020604051808303815f875af115801561047f573d5f5f3e3d5ffd5b505050506040513d601f19601f820116820180604052508101906104a391906108ed565b6104c0576040516312171d8360e31b815260040160405180910390fd5b826001600160a01b0316817f606160394df2742a67735645b7e783304d61d2dbc5b550e8c6acfaf27b6291d7846040516104fc91815260200190565b60405180910390a3505050565b5f546001600160a01b03163314610533576040516330cd747160e01b815260040160405180910390fd5b600180546001600160a01b0319166001600160a01b0383169081179091556040519081527f5719a5656c5cfdaafa148ecf366fd3b0a7fae06449ce2a46225977fb7417e29d906020015b60405180910390a150565b6001546001600160a01b031633148015906105ad57505f546001600160a01b03163314155b156105cb5760405163143606b960e31b815260040160405180910390fd5b6005805460ff19166001908117909155604080519182523360208301527f5030d20e55e366dbc928d61e3b8a2322c5f28d5a605ce4246465849bd80bc86d91016102ae565b5f546001600160a01b0316331461063a576040516330cd747160e01b815260040160405180910390fd5b60028190556040518181527fad4123ae17c414d9c6d2fec478b402e6b01856cc250fd01fbfd252fda0089d3c9060200161057d565b5f546001600160a01b03163314610699576040516330cd747160e01b815260040160405180910390fd5b5f80546001600160a01b0319166001600160a01b0383169081179091556040519081527f04dba622d284ed0014ee4b9a6a68386be1a4c08a4913ae272de89199cc6861639060200161057d565b5f546001600160a01b03163314610710576040516330cd747160e01b815260040160405180910390fd5b60405163a9059cbb60e01b81526001600160a01b038381166004830152602482018390527f0000000000000000000000000000000000000000000000000000000000000000169063a9059cbb906044016020604051808303815f875af115801561077c573d5f5f3e3d5ffd5b505050506040513d601f19601f820116820180604052508101906107a091906108ed565b6107bd576040516312171d8360e31b815260040160405180910390fd5b604080516001600160a01b0384168152602081018390527f7084f5476618d8e60b11ef0d7d3f06914655adb8793e28ff7f018d4c76d505d5910160405180910390a15050565b80356001600160a01b0381168114610819575f5ffd5b919050565b5f5f5f60608486031215610830575f5ffd5b61083984610803565b95602085013595506040909401359392505050565b5f6020828403121561085e575f5ffd5b61086782610803565b9392505050565b5f6020828403121561087e575f5ffd5b5035919050565b5f5f60408385031215610896575f5ffd5b61089f83610803565b946020939093013593505050565b634e487b7160e01b5f52601160045260245ffd5b808201808211156108d4576108d46108ad565b92915050565b818103818111156108d4576108d46108ad565b5f602082840312156108fd575f5ffd5b81518015158114610867575f5ffdfea2646970667358221220eb8bef29644b2d9ab1d3b1890d4e8a37db03ade89c624e738d101768975ad66764736f6c634300081c0033' as const;
