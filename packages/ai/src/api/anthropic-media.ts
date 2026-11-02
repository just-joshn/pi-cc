import type { AnthropicContentBlock, AnthropicMessageParam } from "./anthropic-wire.ts";

export interface MediaLimits {
	items: number;
	itemBuffer: number;
	bytes: number;
	byteBuffer: number;
	documentBytes: number;
}

/** Keep recent media under the request caps, without mutating the stored conversation. */
export function capAnthropicMedia(messages: AnthropicMessageParam[], limits: MediaLimits): AnthropicMessageParam[] {
	const media: Array<{ bytes: number; document: boolean }> = [];
	const collect = (blocks: AnthropicContentBlock[]) => {
		for (const block of blocks) {
			if (block.type === "image" || block.type === "document") {
				media.push({
					bytes: block.source.type === "base64" ? block.source.data.length : 0,
					document: block.type === "document",
				});
			} else if (block.type === "tool_result" && Array.isArray(block.content)) collect(block.content);
		}
	};
	for (const message of messages) if (Array.isArray(message.content)) collect(message.content);
	const removed = new Set<number>();
	const kept: number[] = [];
	let bytes = 0;
	let documentBytes = 0;
	const remove = (index: number) => {
		removed.add(index);
		bytes -= media[index].bytes;
		if (media[index].document) documentBytes -= media[index].bytes;
	};
	for (const [index, item] of media.entries()) {
		kept.push(index);
		bytes += item.bytes;
		if (item.document) documentBytes += item.bytes;
		if (kept.length > limits.items) {
			for (const oldest of kept.splice(0, kept.length - Math.max(0, limits.items - limits.itemBuffer)))
				remove(oldest);
		}
		if (limits.documentBytes > 0 && documentBytes > limits.documentBytes) {
			for (let i = 0; i < kept.length && documentBytes > limits.documentBytes - limits.byteBuffer; ) {
				if (!media[kept[i]].document || media[kept[i]].bytes === 0) {
					i++;
					continue;
				}
				remove(kept.splice(i, 1)[0]);
			}
		}
		if (limits.bytes > 0 && bytes > limits.bytes) {
			for (let i = 0; i < kept.length && bytes > limits.bytes - limits.byteBuffer; ) {
				if (media[kept[i]].bytes === 0) i++;
				else remove(kept.splice(i, 1)[0]);
			}
		}
	}
	if (removed.size === 0) return messages;
	let index = 0;
	const marker = (): AnthropicContentBlock => ({ type: "text", text: "[media removed: request limit]" });
	const replace = (blocks: AnthropicContentBlock[], nested: boolean): AnthropicContentBlock[] =>
		blocks.flatMap((block) => {
			if (block.type === "image" || block.type === "document")
				return removed.has(index++) ? (nested ? [marker()] : []) : [block];
			if (block.type === "tool_result" && Array.isArray(block.content))
				return [{ ...block, content: replace(block.content, true) }];
			return [block];
		});
	return messages.map((message) => {
		if (!Array.isArray(message.content)) return message;
		const content = replace(message.content, false);
		return { ...message, content: content.length > 0 ? content : [marker()] };
	});
}
