// SPDX-License-Identifier: UNLICENSED
// 只用于 test/mev-contract.test.ts 的替身：代币、恒定乘积的 v3 式、Aerodrome v2 式与 Uniswap v2 式池子、工厂、作恶池子。
// 池子的定价是简化的（没有 tick），回调与结算顺序照真实池子：先给输出、再回调、再核对收到的输入。
pragma solidity 0.8.30;

interface ISwapCallback { function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external; }
interface IPancakeV3Callback { function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external; }
interface IHookCallee { function hook(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external; }
interface IV2Callee { function uniswapV2Call(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external; }
interface IPancakeCallee { function pancakeCall(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external; }

contract MockToken {
    mapping(address => uint256) public balanceOf;
    /// 为真时 transfer 不返回值（USDT 式）。
    bool public immutable silent;

    constructor(bool silent_) { silent = silent_; }

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        if (!silent) {
            assembly {
                mstore(0, 1)
                return(0, 32)
            }
        }
    }
}

contract MockV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    uint256 public reserve0;
    uint256 public reserve1;
    bool private locked;
    /// 为真时按 PancakeSwap v3 的名字回调。
    bool public pancake;

    constructor(address a, address b, uint24 fee_, int24 spacing) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        fee = fee_;
        tickSpacing = spacing;
    }

    function sync() external {
        reserve0 = MockToken(token0).balanceOf(address(this));
        reserve1 = MockToken(token1).balanceOf(address(this));
    }

    function setPancake(bool value) external { pancake = value; }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data) external returns (int256 amount0, int256 amount1) {
        require(!locked, "LOK");
        require(amountSpecified > 0, "exact in only");
        locked = true;
        uint256 amountIn = uint256(amountSpecified);
        (uint256 reserveIn, uint256 reserveOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        uint256 net = amountIn * (1_000_000 - fee) / 1_000_000;
        uint256 amountOut = reserveOut * net / (reserveIn + net);
        address tokenIn = zeroForOne ? token0 : token1;
        MockToken(zeroForOne ? token1 : token0).transfer(recipient, amountOut);
        (amount0, amount1) = zeroForOne ? (int256(amountIn), -int256(amountOut)) : (-int256(amountOut), int256(amountIn));
        uint256 beforeBalance = MockToken(tokenIn).balanceOf(address(this));
        if (pancake) IPancakeV3Callback(msg.sender).pancakeV3SwapCallback(amount0, amount1, data);
        else ISwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(MockToken(tokenIn).balanceOf(address(this)) >= beforeBalance + amountIn, "IIA");
        reserve0 = MockToken(token0).balanceOf(address(this));
        reserve1 = MockToken(token1).balanceOf(address(this));
        locked = false;
    }
}

contract MockAeroPool {
    address public immutable token0;
    address public immutable token1;
    /// 万分比。
    uint256 public immutable feeBps;
    uint256 public reserve0;
    uint256 public reserve1;
    bool private locked;

    constructor(address a, address b, uint256 feeBps_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        feeBps = feeBps_;
    }

    function sync() external {
        reserve0 = MockToken(token0).balanceOf(address(this));
        reserve1 = MockToken(token1).balanceOf(address(this));
    }

    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256) {
        (uint256 reserveIn, uint256 reserveOut) = tokenIn == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
        uint256 net = amountIn - amountIn * feeBps / 10_000;
        return reserveOut * net / (reserveIn + net);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external {
        require(!locked, "LOK");
        locked = true;
        require(amount0Out < reserve0 && amount1Out < reserve1, "IL");
        if (amount0Out > 0) MockToken(token0).transfer(to, amount0Out);
        if (amount1Out > 0) MockToken(token1).transfer(to, amount1Out);
        if (data.length > 0) IHookCallee(to).hook(msg.sender, amount0Out, amount1Out, data);
        uint256 balance0 = MockToken(token0).balanceOf(address(this));
        uint256 balance1 = MockToken(token1).balanceOf(address(this));
        uint256 in0 = balance0 > reserve0 - amount0Out ? balance0 - (reserve0 - amount0Out) : 0;
        uint256 in1 = balance1 > reserve1 - amount1Out ? balance1 - (reserve1 - amount1Out) : 0;
        require(in0 > 0 || in1 > 0, "IIA");
        uint256 adjusted0 = balance0 - in0 * feeBps / 10_000;
        uint256 adjusted1 = balance1 - in1 * feeBps / 10_000;
        require(adjusted0 * adjusted1 >= reserve0 * reserve1, "K");
        reserve0 = balance0;
        reserve1 = balance1;
        locked = false;
    }
}

/// Uniswap v2 式池子：费率是常数（万分比），K 检查照 Uniswap v2 的写法；`pancake` 为真时按 BaseSwap 的名字回调。
contract MockV2Pair {
    address public immutable token0;
    address public immutable token1;
    uint256 public immutable feeBps;
    bool public immutable pancake;
    uint112 private reserve0;
    uint112 private reserve1;
    bool private locked;

    constructor(address a, address b, uint256 feeBps_, bool pancake_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        feeBps = feeBps_;
        pancake = pancake_;
    }

    function sync() external {
        reserve0 = uint112(MockToken(token0).balanceOf(address(this)));
        reserve1 = uint112(MockToken(token1).balanceOf(address(this)));
    }

    function getReserves() external view returns (uint112, uint112, uint32) { return (reserve0, reserve1, 0); }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external {
        require(!locked, "LOK");
        locked = true;
        require(amount0Out > 0 || amount1Out > 0, "IOA");
        require(amount0Out < reserve0 && amount1Out < reserve1, "IL");
        if (amount0Out > 0) MockToken(token0).transfer(to, amount0Out);
        if (amount1Out > 0) MockToken(token1).transfer(to, amount1Out);
        if (data.length > 0) {
            if (pancake) IPancakeCallee(to).pancakeCall(msg.sender, amount0Out, amount1Out, data);
            else IV2Callee(to).uniswapV2Call(msg.sender, amount0Out, amount1Out, data);
        }
        uint256 balance0 = MockToken(token0).balanceOf(address(this));
        uint256 balance1 = MockToken(token1).balanceOf(address(this));
        uint256 in0 = balance0 > reserve0 - amount0Out ? balance0 - (reserve0 - amount0Out) : 0;
        uint256 in1 = balance1 > reserve1 - amount1Out ? balance1 - (reserve1 - amount1Out) : 0;
        require(in0 > 0 || in1 > 0, "IIA");
        uint256 adjusted0 = balance0 * 10_000 - in0 * feeBps;
        uint256 adjusted1 = balance1 * 10_000 - in1 * feeBps;
        require(adjusted0 * adjusted1 >= uint256(reserve0) * reserve1 * 100_000_000, "K");
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        locked = false;
    }
}

contract MockFactory {
    mapping(bytes32 => address) private byFee;
    mapping(bytes32 => address) private bySpacing;
    mapping(address => bool) public isPool;
    mapping(bytes32 => address) private pairs;

    function registerFee(address pool) external {
        MockV3Pool target = MockV3Pool(pool);
        byFee[keccak256(abi.encode(target.token0(), target.token1(), target.fee()))] = pool;
    }

    function registerSpacing(address pool) external {
        MockV3Pool target = MockV3Pool(pool);
        bySpacing[keccak256(abi.encode(target.token0(), target.token1(), target.tickSpacing()))] = pool;
    }

    function registerPool(address pool) external { isPool[pool] = true; }

    function registerPair(address pool) external {
        MockV2Pair target = MockV2Pair(pool);
        pairs[keccak256(abi.encode(target.token0(), target.token1()))] = pool;
    }

    function getPair(address a, address b) external view returns (address) {
        (address token0, address token1) = a < b ? (a, b) : (b, a);
        return pairs[keccak256(abi.encode(token0, token1))];
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        (address token0, address token1) = a < b ? (a, b) : (b, a);
        return byFee[keccak256(abi.encode(token0, token1, fee))];
    }

    function getPool(address a, address b, int24 spacing) external view returns (address) {
        (address token0, address token1) = a < b ? (a, b) : (b, a);
        return bySpacing[keccak256(abi.encode(token0, token1, spacing))];
    }
}

/// 不在兑换中时直接调执行合约的各个回调，企图让它付款。
contract EvilPool {
    function callSwapCallback(address executor, bytes calldata data) external {
        ISwapCallback(executor).uniswapV3SwapCallback(int256(1 ether), -int256(1), data);
    }

    function callHook(address executor, bytes calldata data) external {
        IHookCallee(executor).hook(executor, 1, 0, data);
    }

    function callPancakeV3(address executor, bytes calldata data) external {
        IPancakeV3Callback(executor).pancakeV3SwapCallback(int256(1 ether), -int256(1), data);
    }

    function callV2(address executor, bytes calldata data) external {
        IV2Callee(executor).uniswapV2Call(executor, 1, 0, data);
    }

    function callPancake(address executor, bytes calldata data) external {
        IPancakeCallee(executor).pancakeCall(executor, 1, 0, data);
    }
}
