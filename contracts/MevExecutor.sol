// SPDX-License-Identifier: UNLICENSED
// MEV 套利执行合约（docs/mev.md）。一笔交易里沿环路做 2–4 跳兑换，第一跳用池子的闪电兑换先拿到输出，
// 在回调里走完其余各跳后再付第一跳的输入；结束时起始代币的增量小于 minProfit 就整笔回滚。
// 合约不留本金：每次成功后把起始代币余额全部转给 owner。operator（热钱包）只能调 execute，没有任何提币入口。
// 只和 owner 登记过的工厂创建的池子交互，回调只接受当前正在兑换的那个池子。不可升级，没有 delegatecall。
pragma solidity 0.8.30;

interface IERC20Balance { function balanceOf(address account) external view returns (uint256); }

interface IPoolTokens {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// Uniswap v3 池子；Aerodrome Slipstream 的 CLPool 的 swap 与回调签名相同。
interface IV3Pool {
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256 amount0, int256 amount1);
}

interface IV3Factory { function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address); }
interface ISlipstreamFactory { function getPool(address tokenA, address tokenB, int24 tickSpacing) external view returns (address); }

/// Aerodrome v2（Solidly 类）池子。
interface IAeroPool {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IAeroFactory { function isPool(address pool) external view returns (bool); }

contract MevExecutor {
    struct Hop {
        address pool;
        address factory;
        address tokenIn;
        address tokenOut;
    }

    uint8 public constant KIND_NONE = 0;
    uint8 public constant KIND_V3 = 1;
    uint8 public constant KIND_SLIPSTREAM = 2;
    uint8 public constant KIND_AERO_V2 = 3;

    uint160 private constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    address public immutable owner;
    address public operator;
    mapping(address => uint8) public factoryKind;
    /// 当前允许回调的池子；不在兑换中时为零地址。
    address private _expected;
    bool private _running;

    event Executed(address indexed startToken, uint256 amountIn, uint256 profit);
    event OperatorChanged(address indexed operator);
    event FactoryChanged(address indexed factory, uint8 kind);

    error NotOwner();
    error NotOperator();
    error Expired();
    error BadPath();
    error BadPool();
    error BadCallback();
    error TransferFailed();
    /// 结束时的余额没有达到 before + minProfit。
    error NoProfit(uint256 balanceAfter, uint256 balanceBefore);

    constructor(address owner_, address operator_, address[] memory factories, uint8[] memory kinds) {
        if (owner_ == address(0) || factories.length != kinds.length) revert BadPath();
        owner = owner_;
        operator = operator_;
        emit OperatorChanged(operator_);
        for (uint256 i = 0; i < factories.length; i++) _setFactory(factories[i], kinds[i]);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// 换热钱包；设为零地址即停用 execute。
    function setOperator(address operator_) external onlyOwner {
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function setFactory(address factory, uint8 kind) external onlyOwner {
        _setFactory(factory, kind);
    }

    /// 把合约里某种代币的全部余额转给 owner（正常情况下合约没有余额）。
    function rescue(address token) external onlyOwner {
        _send(token, owner, IERC20Balance(token).balanceOf(address(this)));
    }

    /// 沿 hops 做一轮套利。amountIn 是第一跳的输入数量（起始代币），不需要合约事先持有。
    /// 返回值是起始代币的净增量，供 eth_call 模拟读取。
    function execute(Hop[] calldata hops, uint256 amountIn, uint256 minProfit, uint256 deadlineBlock) external returns (uint256 profit) {
        if (msg.sender != operator) revert NotOperator();
        if (block.number > deadlineBlock) revert Expired();
        if (_running) revert BadCallback();
        uint256 count = hops.length;
        if (count < 2 || count > 4 || amountIn == 0 || amountIn > uint256(type(int256).max)) revert BadPath();
        address start = hops[0].tokenIn;
        if (hops[count - 1].tokenOut != start) revert BadPath();
        Hop[] memory rest = new Hop[](count - 1);
        for (uint256 i = 0; i < count; i++) {
            if (i > 0) {
                if (hops[i].tokenIn != hops[i - 1].tokenOut) revert BadPath();
                rest[i - 1] = hops[i];
            }
            _check(hops[i]);
        }
        _running = true;
        uint256 balanceBefore = IERC20Balance(start).balanceOf(address(this));
        _swap(hops[0], amountIn, true, abi.encode(rest, start, amountIn));
        _running = false;
        uint256 balanceAfter = IERC20Balance(start).balanceOf(address(this));
        if (balanceAfter < balanceBefore + minProfit) revert NoProfit(balanceAfter, balanceBefore);
        profit = balanceAfter - balanceBefore;
        if (balanceAfter > 0) _send(start, owner, balanceAfter);
        emit Executed(start, amountIn, profit);
    }

    /// Uniswap v3 与 Slipstream 池子在 swap 里回调：先走完其余各跳（只有第一跳带着），再付这一跳的输入。
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender != _expected) revert BadCallback();
        _expected = address(0);
        if (amount0Delta <= 0 && amount1Delta <= 0) revert BadCallback();
        (Hop[] memory rest, address tokenIn,) = abi.decode(data, (Hop[], address, uint256));
        (uint256 owed, uint256 received) = amount0Delta > 0 ? (uint256(amount0Delta), uint256(-amount1Delta)) : (uint256(amount1Delta), uint256(-amount0Delta));
        address pool = msg.sender;
        _run(rest, received);
        _send(tokenIn, pool, owed);
    }

    /// Aerodrome v2 池子在带数据的 swap 里回调（只用于第一跳）。
    function hook(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external {
        if (msg.sender != _expected || sender != address(this)) revert BadCallback();
        _expected = address(0);
        (Hop[] memory rest, address tokenIn, uint256 amountIn) = abi.decode(data, (Hop[], address, uint256));
        address pool = msg.sender;
        _run(rest, amount0 > 0 ? amount0 : amount1);
        _send(tokenIn, pool, amountIn);
    }

    function _run(Hop[] memory rest, uint256 amount) private {
        bytes memory payOnly = abi.encode(new Hop[](0), address(0), uint256(0));
        for (uint256 i = 0; i < rest.length; i++) {
            payOnly = abi.encode(new Hop[](0), rest[i].tokenIn, uint256(0));
            amount = _swap(rest[i], amount, false, payOnly);
        }
    }

    function _swap(Hop memory hop, uint256 amountIn, bool flash, bytes memory data) private returns (uint256 amountOut) {
        uint8 kind = factoryKind[hop.factory];
        if (kind == KIND_V3 || kind == KIND_SLIPSTREAM) {
            bool zeroForOne = hop.tokenIn < hop.tokenOut;
            _expected = hop.pool;
            (int256 amount0, int256 amount1) = IV3Pool(hop.pool).swap(address(this), zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE, data);
            _expected = address(0);
            int256 out = zeroForOne ? amount1 : amount0;
            if (out >= 0) revert BadPool();
            amountOut = uint256(-out);
        } else if (kind == KIND_AERO_V2) {
            amountOut = IAeroPool(hop.pool).getAmountOut(amountIn, hop.tokenIn);
            if (amountOut == 0) revert BadPool();
            (uint256 out0, uint256 out1) = hop.tokenIn < hop.tokenOut ? (uint256(0), amountOut) : (amountOut, uint256(0));
            if (flash) {
                _expected = hop.pool;
                IAeroPool(hop.pool).swap(out0, out1, address(this), data);
                // 池子没有回调（就拿不到输入）时它自己的不变量检查会回滚；这里再确认回调确实发生过。
                if (_expected != address(0)) revert BadCallback();
            } else {
                _send(hop.tokenIn, hop.pool, amountIn);
                IAeroPool(hop.pool).swap(out0, out1, address(this), "");
            }
        } else {
            revert BadPool();
        }
    }

    /// 池子必须由登记过的工厂创建，且这一跳的两种代币正是池子的两种代币。
    function _check(Hop calldata hop) private view {
        uint8 kind = factoryKind[hop.factory];
        address token0 = IPoolTokens(hop.pool).token0();
        address token1 = IPoolTokens(hop.pool).token1();
        if (!((hop.tokenIn == token0 && hop.tokenOut == token1) || (hop.tokenIn == token1 && hop.tokenOut == token0))) revert BadPool();
        if (kind == KIND_V3) {
            if (IV3Factory(hop.factory).getPool(token0, token1, IV3Pool(hop.pool).fee()) != hop.pool) revert BadPool();
        } else if (kind == KIND_SLIPSTREAM) {
            if (ISlipstreamFactory(hop.factory).getPool(token0, token1, IV3Pool(hop.pool).tickSpacing()) != hop.pool) revert BadPool();
        } else if (kind == KIND_AERO_V2) {
            if (!IAeroFactory(hop.factory).isPool(hop.pool)) revert BadPool();
        } else {
            revert BadPool();
        }
    }

    function _setFactory(address factory, uint8 kind) private {
        if (factory == address(0) || kind > KIND_AERO_V2) revert BadPath();
        factoryKind[factory] = kind;
        emit FactoryChanged(factory, kind);
    }

    /// transfer 不返回值的代币（如 USDT）也接受；返回 false 或调用失败即回滚。
    function _send(address token, address to, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool))) || (result.length == 0 && token.code.length == 0)) revert TransferFailed();
    }
}
