import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  PaymentIntent,
  PaymentIntent as PaymentIntentRow,
} from '../../infrastructure/database/schema/invoices.schema';
import type { CreatePaymentIntentInput } from './dto/create-payment-intent.dto';
import type { PaymentIntentResponse } from './dto/payment-intent-response.dto';
import type { RecordPaymentInput } from './dto/record-payment.dto';
import { InvoicesService } from './invoices.service';
import { PaymentIntentsRepository } from './payment-intents.repository';

type Channel = PaymentIntent['channel'];

// A gateway charge lives for one day before it lapses.
const INTENT_TTL_MS = 24 * 60 * 60 * 1000;

// Virtual-account BIN per bank (mock; real numbers come from the gateway).
const VA_PREFIX: Record<'va_bca' | 'va_mandiri' | 'va_bri' | 'va_bni', string> = {
  va_bca: '8808',
  va_mandiri: '8950',
  va_bri: '8888',
  va_bni: '8810',
};

@Injectable()
export class PaymentIntentsService {
  private readonly logger = new Logger(PaymentIntentsService.name);

  constructor(
    private readonly repo: PaymentIntentsRepository,
    // Intents settle real invoices, so they go through the billing service
    // (mark paid + ledger entry + customer reactivation).
    private readonly invoices: InvoicesService,
  ) {}

  async create(input: CreatePaymentIntentInput): Promise<PaymentIntentResponse> {
    const invoice = await this.invoices.findById(input.invoiceId);
    if (invoice.status === 'paid') {
      throw new ConflictException('invoice already paid');
    }

    const amount = invoice.amount + invoice.lateFee + invoice.taxAmount;
    const { channel } = input;
    // Inline guard so the type predicate narrows `channel` in each branch.
    const row = await this.repo.create({
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      customerName: invoice.customerName,
      amount,
      channel,
      status: 'pending',
      vaNumber: isVaChannel(channel) ? buildVaNumber(channel, invoice.invoiceNo) : null,
      qrPayload: isVaChannel(channel) ? null : buildQrPayload(channel, invoice.invoiceNo, amount),
      expiresAt: new Date(Date.now() + INTENT_TTL_MS),
    });
    this.logger.log({ intentId: row.id, channel: row.channel }, 'payment intent created');
    return toIntentResponse(row);
  }

  /** Simulate the gateway settlement webhook: settle the invoice + mark paid. */
  async confirm(id: string): Promise<PaymentIntentResponse> {
    const intent = await this.repo.findById(id);
    if (!intent) throw new NotFoundException('payment intent not found');
    if (intent.status === 'paid') {
      return toIntentResponse(intent); // idempotent — webhook may retry
    }
    if (intent.status === 'expired' || intent.expiresAt.getTime() <= Date.now()) {
      if (intent.status !== 'expired') await this.repo.markExpired(id);
      throw new ConflictException('payment intent expired');
    }

    await this.invoices.pay(intent.invoiceId, { method: channelToMethod(intent.channel) });
    const paid = await this.repo.markPaid(id);
    this.logger.log({ intentId: id, invoiceId: intent.invoiceId }, 'payment intent settled');
    return toIntentResponse(paid);
  }
}

function isVaChannel(channel: Channel): channel is keyof typeof VA_PREFIX {
  return channel in VA_PREFIX;
}

function buildVaNumber(channel: keyof typeof VA_PREFIX, invoiceNo: string): string {
  const tail = invoiceNo.replace(/\D/g, '').slice(-10).padStart(10, '0');
  return `${VA_PREFIX[channel]}${tail}`;
}

function buildQrPayload(channel: Channel, invoiceNo: string, amount: number): string {
  return `ID.MOCK.QRIS|${channel}|${invoiceNo}|${amount}`;
}

function channelToMethod(channel: Channel): RecordPaymentInput['method'] {
  if (channel === 'qris') return 'qris';
  if (isVaChannel(channel)) return 'va';
  return 'ewallet'; // gopay / ovo / dana / shopeepay
}

function toIntentResponse(row: PaymentIntentRow): PaymentIntentResponse {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    invoiceNo: row.invoiceNo,
    customerName: row.customerName,
    amount: row.amount,
    channel: row.channel,
    status: row.status,
    vaNumber: row.vaNumber,
    qrPayload: row.qrPayload,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
  };
}
