import axios from "axios";
import Whisper from "main";
import { Notice, MarkdownView } from "obsidian";
import { getBaseFileName } from "./utils";

interface Segment {
	speaker?: string;
	text: string;
}

// verbose_json (diarized) returns speaker-tagged segments; plain json returns { text }
function formatTranscript(data: { text?: string; segments?: Segment[] }): string {
	const segments = data.segments;
	if (!Array.isArray(segments) || !segments.some((s) => s.speaker))
		return data.text ?? "";
	// merge consecutive same-speaker segments into one labeled line
	const lines: string[] = [];
	let last: string | null = null;
	for (const seg of segments) {
		const speaker = seg.speaker ?? "Unknown";
		if (speaker === last) {
			lines[lines.length - 1] += " " + seg.text.trim();
		} else {
			lines.push(`${speaker}: ${seg.text.trim()}`);
			last = speaker;
		}
	}
	return lines.join("\n");
}

export class AudioHandler {
	private plugin: Whisper;

	constructor(plugin: Whisper) {
		this.plugin = plugin;
	}

	async sendAudioData(blob: Blob, fileName: string): Promise<void> {
		// Get the base file name without extension
		const baseFileName = getBaseFileName(fileName);

		const audioFilePath = `${
			this.plugin.settings.saveAudioFilePath
				? `${this.plugin.settings.saveAudioFilePath}/`
				: ""
		}${fileName}`;

		const noteFilePath = `${
			this.plugin.settings.createNewFileAfterRecordingPath
				? `${this.plugin.settings.createNewFileAfterRecordingPath}/`
				: ""
		}${baseFileName}.md`;

		if (this.plugin.settings.debugMode) {
			new Notice(`Sending audio data size: ${blob.size / 1000} KB`);
		}

		if (!this.plugin.settings.apiKey) {
			new Notice(
				"API key is missing. Please add your API key in the settings."
			);
			return;
		}

		const formData = new FormData();
		formData.append("file", blob, fileName);
		formData.append("model", this.plugin.settings.model);
		formData.append("language", this.plugin.settings.language);
		if (this.plugin.settings.diarize) {
			// whisperx-api-server: diarize needs align=true and speakers live in verbose_json
			formData.append("diarize", "true");
			formData.append("align", "true");
			formData.append("response_format", "verbose_json");
		}
		if (this.plugin.settings.prompt)
			formData.append("prompt", this.plugin.settings.prompt);

		try {
			// If the saveAudioFile setting is true, save the audio file
			if (this.plugin.settings.saveAudioFile) {
				const arrayBuffer = await blob.arrayBuffer();
				await this.plugin.app.vault.adapter.writeBinary(
					audioFilePath,
					new Uint8Array(arrayBuffer)
				);
				new Notice("Audio saved successfully.");
			}
		} catch (err) {
			console.error("Error saving audio file:", err);
			new Notice("Error saving audio file: " + err.message);
		}

		try {
			if (this.plugin.settings.debugMode) {
				new Notice("Parsing audio data:" + fileName);
			}
			const response = await axios.post(
				this.plugin.settings.apiUrl,
				formData,
				{
					headers: {
						"Content-Type": "multipart/form-data",
						Authorization: `Bearer ${this.plugin.settings.apiKey}`,
					},
				}
			);

			const transcript = formatTranscript(response.data);

			// Determine if a new file should be created
			const activeView =
				this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
			const shouldCreateNewFile =
				this.plugin.settings.createNewFileAfterRecording || !activeView;

			if (shouldCreateNewFile) {
				await this.plugin.app.vault.create(
					noteFilePath,
					`![[${audioFilePath}]]\n${transcript}`
				);
				await this.plugin.app.workspace.openLinkText(
					noteFilePath,
					"",
					true
				);
			} else {
				// Insert the transcription at the cursor position
				const editor =
					this.plugin.app.workspace.getActiveViewOfType(
						MarkdownView
					)?.editor;
				if (editor) {
					const cursorPosition = editor.getCursor();
					editor.replaceRange(transcript, cursorPosition);

					// Move the cursor to the end of the inserted text
					const newPosition = {
						line: cursorPosition.line,
						ch: cursorPosition.ch + transcript.length,
					};
					editor.setCursor(newPosition);
				}
			}

			new Notice("Audio parsed successfully.");
		} catch (err) {
			const detail = err.response?.data;
			console.error("Error parsing audio:", detail ?? err);
			const msg = detail
				? typeof detail === "string"
					? detail
					: JSON.stringify(detail)
				: err.message;
			new Notice("Error parsing audio: " + msg);
		}
	}
}
