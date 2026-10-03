/**
 * Telegram Notifier
 * Uses Telegram Bot API sendMessage only (no polling/getUpdates to avoid conflicts).
 * Gracefully disables if credentials are not configured.
 * Never prints or leaks bot tokens.
 */

export interface Notifier {
  readonly isEnabled: boolean;
  notifyStraddleEntered(params: {
    readonly strike: number;
    readonly callSymbol: string;
    readonly callPrice: number;
    readonly callPriceSource: 'fill' | 'mark';
    readonly putSymbol: string;
    readonly putPrice: number;
    readonly putPriceSource: 'fill' | 'mark';
    readonly totalCredit: number;
    readonly callSL: number;
    readonly putSL: number;
    readonly targetProfit: number;
  }): Promise<void>;
  notifyLegClosed(params: {
    readonly legType: 'CALL' | 'PUT';
    readonly symbol: string;
    readonly reason: string;
    readonly exitPrice: number;
    readonly runningPnL: number;
  }): Promise<void>;
  notifyScenarioResolved(params: {
    readonly scenario: string;
    readonly totalCredit: number;
    readonly combinedPnL: number;
    readonly summary: string;
  }): Promise<void>;
  notifyEntryAborted(params: {
    readonly reason: string;
    readonly callSuccess: boolean;
    readonly putSuccess: boolean;
    readonly unwoundLeg?: string;
  }): Promise<void>;
  notifyError(context: string, error: unknown): Promise<void>;
  notifyReconciliation(message: string): Promise<void>;
}

export class TelegramNotifier implements Notifier {
  private readonly botToken: string;
  private readonly chatId: string;
  public readonly isEnabled: boolean;

  constructor(botToken?: string, chatId?: string) {
    this.botToken = (botToken || '').trim();
    this.chatId = (chatId || '').trim();
    this.isEnabled = Boolean(this.botToken && this.chatId);

    if (this.isEnabled) {
      console.log('[Notifier] Telegram alerting enabled.');
    } else {
      console.log('[Notifier] Telegram alerting disabled (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set).');
    }
  }

  private async send(text: string): Promise<void> {
    if (!this.isEnabled) return;

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Notifier] Telegram send failed (HTTP ${response.status}): ${errorText}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Notifier] Network error sending Telegram alert: ${msg}`);
    }
  }

  public async notifyStraddleEntered(params: {
    readonly strike: number;
    readonly callSymbol: string;
    readonly callPrice: number;
    readonly callPriceSource: 'fill' | 'mark';
    readonly putSymbol: string;
    readonly putPrice: number;
    readonly putPriceSource: 'fill' | 'mark';
    readonly totalCredit: number;
    readonly callSL: number;
    readonly putSL: number;
    readonly targetProfit: number;
  }): Promise<void> {
    const text =
      `🚀 <b>BTC 0DTE Straddle Entered</b>\n\n` +
      `<b>ATM Strike:</b> $${params.strike}\n` +
      `<b>Call:</b> <code>${params.callSymbol}</code> @ $${params.callPrice.toFixed(2)} (${params.callPriceSource})\n` +
      `<b>Put:</b> <code>${params.putSymbol}</code> @ $${params.putPrice.toFixed(2)} (${params.putPriceSource})\n` +
      `<b>Total Credit:</b> $${params.totalCredit.toFixed(2)} pts\n\n` +
      `<b>Thresholds:</b>\n` +
      `• Call SL (+100%): $${params.callSL.toFixed(2)}\n` +
      `• Put SL (+100%): $${params.putSL.toFixed(2)}\n` +
      `• Target (+55%): +$${params.targetProfit.toFixed(2)} pts`;

    await this.send(text);
  }

  public async notifyLegClosed(params: {
    readonly legType: 'CALL' | 'PUT';
    readonly symbol: string;
    readonly reason: string;
    readonly exitPrice: number;
    readonly runningPnL: number;
  }): Promise<void> {
    const icon = params.reason === 'SL_HIT' ? '⚠️' : '✅';
    const text =
      `${icon} <b>${params.legType} Leg Closed</b>\n\n` +
      `<b>Symbol:</b> <code>${params.symbol}</code>\n` +
      `<b>Reason:</b> ${params.reason}\n` +
      `<b>Exit Price:</b> $${params.exitPrice.toFixed(2)}\n` +
      `<b>Running Combined PnL:</b> ${params.runningPnL >= 0 ? '+' : ''}${params.runningPnL.toFixed(2)} pts`;

    await this.send(text);
  }

  public async notifyScenarioResolved(params: {
    readonly scenario: string;
    readonly totalCredit: number;
    readonly combinedPnL: number;
    readonly summary: string;
  }): Promise<void> {
    const icon = params.combinedPnL >= 0 ? '🎯' : '🛑';
    const text =
      `${icon} <b>Straddle Resolved: ${params.scenario}</b>\n\n` +
      `<b>Total Credit:</b> $${params.totalCredit.toFixed(2)} pts\n` +
      `<b>Final PnL:</b> ${params.combinedPnL >= 0 ? '+' : ''}${params.combinedPnL.toFixed(2)} pts\n` +
      `<b>Summary:</b> ${params.summary}`;

    await this.send(text);
  }

  public async notifyEntryAborted(params: {
    readonly reason: string;
    readonly callSuccess: boolean;
    readonly putSuccess: boolean;
    readonly unwoundLeg?: string;
  }): Promise<void> {
    const unwoundInfo = params.unwoundLeg ? `\n<b>Auto-Unwound Leg:</b> <code>${params.unwoundLeg}</code>` : '';
    const text =
      `🚨 <b>ENTRY ABORTED / PARTIAL FAILURE</b>\n\n` +
      `<b>Reason:</b> ${params.reason}\n` +
      `<b>Call Fill:</b> ${params.callSuccess ? 'SUCCESS' : 'FAILED'}\n` +
      `<b>Put Fill:</b> ${params.putSuccess ? 'SUCCESS' : 'FAILED'}` +
      unwoundInfo;

    await this.send(text);
  }

  public async notifyError(context: string, error: unknown): Promise<void> {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const text =
      `❌ <b>Bot Error in ${context}</b>\n\n` +
      `<code>${errorMsg}</code>`;

    await this.send(text);
  }

  public async notifyReconciliation(message: string): Promise<void> {
    const text = `🔄 <b>Startup State Reconciliation</b>\n\n${message}`;
    await this.send(text);
  }
}
