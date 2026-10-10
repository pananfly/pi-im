export interface InboundMessage {
	messageId: string;
	chatId: string;
	chatType: "p2p" | "group";
	senderId: string;
	senderName?: string;
	text: string;
	mentionBot?: boolean;
	hasImage?: boolean;
	timestampMs: number;
}
export interface ChannelLike {
	sendText(chatId: string, text: string, replyTo?: string): Promise<string>;
	editText(chatId: string, messageId: string, text: string): Promise<void>;
	sendImage?(chatId: string, buf: Buffer, filename: string): Promise<void>;
	sendFile?(chatId: string, buf: Buffer, filename: string): Promise<void>;
}
export interface ProgressRenderer {
	start(chatId: string, title: string): Promise<void>;
	update(text: string): Promise<void>;
	finish(finalText: string): Promise<void>;
}
