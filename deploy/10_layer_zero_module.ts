declare var global: any;
import { BigNumber, Contract } from 'ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from '@holographxyz/hardhat-deploy-holographed/types';
import { NetworkType, Network, networks } from '@holographxyz/networks';
import {
  genesisDeriveFutureAddress,
  txParams,
  genesisDeployHelper,
  generateInitCode,
  zeroAddress,
  LeanHardhatRuntimeEnvironment,
  hreSplit,
} from '../scripts/utils/helpers';
import { SuperColdStorageSigner } from 'super-cold-storage-signer';

const func: DeployFunction = async function (hre1: HardhatRuntimeEnvironment) {
  let { hre, hre2 } = await hreSplit(hre1, global.__companionNetwork);
  const accounts = await hre.ethers.getSigners();
  let deployer: SignerWithAddress | SuperColdStorageSigner = accounts[0];

  if (global.__superColdStorage) {
    // address, domain, authorization, ca
    const coldStorage = global.__superColdStorage;
    deployer = new SuperColdStorageSigner(
      coldStorage.address,
      'https://' + coldStorage.domain,
      coldStorage.authorization,
      deployer.provider,
      coldStorage.ca
    );
  }

  const error = function (err: string) {
    hre.deployments.log(err);
    process.exit();
  };

  const salt = hre.deploymentSalt;

  const MSG_BASE_GAS: BigNumber = BigNumber.from('110000');
  const MSG_GAS_PER_BYTE: BigNumber = BigNumber.from('25');
  const JOB_BASE_GAS: BigNumber = BigNumber.from('160000');
  const JOB_GAS_PER_BYTE: BigNumber = BigNumber.from('35');
  const MIN_GAS_PRICE: BigNumber = BigNumber.from('1');
  const GAS_LIMIT: BigNumber = BigNumber.from('10000001');

  const defaultParams: BigNumber[] = [
    MSG_BASE_GAS,
    MSG_GAS_PER_BYTE,
    JOB_BASE_GAS,
    JOB_GAS_PER_BYTE,
    MIN_GAS_PRICE,
    GAS_LIMIT,
  ];

  const network: Network = networks[hre.networkName];
  const networkType: NetworkType = network.type;
  const networkKeys: string[] = Object.keys(networks);
  const networkValues: Network[] = Object.values(networks);
  let supportedNetworkNames: string[] = [];
  let supportedNetworks: Network[] = [];
  let chainIds: number[] = [];
  let gasParameters: BigNumber[][] = [];
  for (let i = 0, l = networkKeys.length; i < l; i++) {
    const key: string = networkKeys[i];
    const value: Network = networkValues[i];
    if (value.type == networkType) {
      supportedNetworkNames.push(key);
      supportedNetworks.push(value);
      if (value.holographId > 0) {
        if (value.holographId == network.holographId) {
          chainIds.push(0);
          gasParameters.push(defaultParams);
        }
        chainIds.push(value.holographId);
        gasParameters.push(defaultParams);
      }
    }
  }

  const holograph = await hre.ethers.getContract('Holograph', deployer);

  const futureLayerZeroModuleAddress = await genesisDeriveFutureAddress(
    hre,
    salt,
    'LayerZeroModule',
    generateInitCode(
      ['address', 'address', 'address', 'uint32[]', 'struct(uint256,uint256,uint256,uint256,uint256,uint256)[]'],
      [zeroAddress, zeroAddress, zeroAddress, [], []]
    )
  );
  hre.deployments.log('the future "LayerZeroModule" address is', futureLayerZeroModuleAddress);

  // LayerZeroModule
  let layerZeroModuleDeployedCode: string = await hre.provider.send('eth_getCode', [
    futureLayerZeroModuleAddress,
    'latest',
  ]);
  if (layerZeroModuleDeployedCode == '0x' || layerZeroModuleDeployedCode == '') {
    hre.deployments.log('"LayerZeroModule" bytecode not found, need to deploy"');
    let layerZeroModule = await genesisDeployHelper(
      hre,
      salt,
      'LayerZeroModule',
      generateInitCode(
        ['address', 'address', 'address', 'uint32[]', 'struct(uint256,uint256,uint256,uint256,uint256,uint256)[]'],
        [
          await holograph.getBridge(),
          await holograph.getInterfaces(),
          await holograph.getOperator(),
          chainIds,
          gasParameters,
        ]
      ),
      futureLayerZeroModuleAddress
    );
  } else {
    hre.deployments.log('"LayerZeroModule" is already deployed..');
  }

  const holographOperator = ((await hre.ethers.getContract('HolographOperator', deployer)) as Contract).attach(
    await holograph.getOperator()
  );

  if ((await holographOperator.getMessagingModule()).toLowerCase() != futureLayerZeroModuleAddress.toLowerCase()) {
    const lzTx = await holographOperator
      .setMessagingModule(futureLayerZeroModuleAddress, {
        ...(await txParams({
          hre,
          from: deployer,
          to: holographOperator,
          data: holographOperator.populateTransaction.setMessagingModule(futureLayerZeroModuleAddress),
        })),
      })
      .catch(error);
    hre.deployments.log('Transaction hash:', lzTx.hash);
    await lzTx.wait();
    hre.deployments.log(`Registered MessagingModule to: ${await holographOperator.getMessagingModule()}`);
  } else {
    hre.deployments.log(`MessagingModule is already registered to: ${await holographOperator.getMessagingModule()}`);
  }

  const lzModule = (await hre.ethers.getContract('LayerZeroModule', deployer)) as Contract;

  chainIds = [];
  gasParameters = [];

  for (let i = 0, l = supportedNetworks.length; i < l; i++) {
    let currentNetwork: Network = supportedNetworks[i];
    let currentGasParameters: BigNumber[] = await lzModule.getGasParameters(currentNetwork.holographId);
    for (let i = 0; i < 6; i++) {
      if (!defaultParams[i].eq(currentGasParameters[i])) {
        chainIds.push(currentNetwork.holographId);
        gasParameters.push(defaultParams);
        break;
      }
    }
  }
  if (chainIds.length > 0) {
    hre.deployments.log('Found some gas parameter inconsistencies');
    const lzTx = await lzModule['setGasParameters(uint32[],(uint256,uint256,uint256,uint256,uint256,uint256)[])'](
      chainIds,
      gasParameters,
      {
        ...(await txParams({
          hre,
          from: deployer,
          to: lzModule,
          data: lzModule.populateTransaction[
            'setGasParameters(uint32[],(uint256,uint256,uint256,uint256,uint256,uint256)[])'
          ](chainIds, gasParameters),
        })),
      }
    ).catch(error);
    hre.deployments.log('Transaction hash:', lzTx.hash);
    await lzTx.wait();
    hre.deployments.log('Updated LayerZero GasParameters');
  }
};

export default func;
func.tags = ['LayerZeroModule'];
func.dependencies = ['HolographGenesis', 'DeploySources'];