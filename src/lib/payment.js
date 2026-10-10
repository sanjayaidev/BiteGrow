'use strict';
// How an order is paid. There is no online payment gateway on this server: the customer pays when they
// receive the order, and the payment status ("unpaid" -> "paid") is changed by staff in the order desk,
// or by an outside payment server through the signed webhook (src/routes/paymentWebhook.js).
//
//   dine_in  -> cash            paid to the waiter or at the counter
//   pickup   -> pay_at_pickup   paid when the customer collects the order
//   delivery -> cod             cash on delivery, paid to the rider

const METHOD_FOR = { dine_in: 'cash', pickup: 'pay_at_pickup', delivery: 'cod' };
const LABEL = { cash: 'Cash', pay_at_pickup: 'Pay at pickup', cod: 'Cash on delivery' };

const methodFor = (orderType) => METHOD_FOR[orderType] || 'cash';
// Orders placed before this feature have no stored method; show what their order type would have used.
const methodOf = (order) => (order && order.payment_method) || methodFor(order && order.order_type);
const labelFor = (method) => LABEL[method] || '';

module.exports = { METHOD_FOR, LABEL, methodFor, methodOf, labelFor };
