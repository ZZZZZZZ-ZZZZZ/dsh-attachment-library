window.__ModuleLoader__.load({
	id: "dsh-plugin-attachment-library",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/protocol.ts
		/** Typert namespace and Cordis service key of the library service. */
		const ATTACHMENT_LIBRARY_NAMESPACE = "attachmentLibrary";
		/** npm package that owns the Remote methods. */
		const ATTACHMENT_LIBRARY_PACKAGE = "dsh-plugin-attachment-library";
		function strict(typeSymbol, parse) {
			const schema = { parse };
			return {
				mode: "strict",
				typeSymbol,
				create: () => schema
			};
		}
		function record(value, what) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${what} must be an object`);
			return value;
		}
		function exactKeys(value, required, optional, what) {
			for (const key of required) if (!(key in value)) throw new TypeError(`${what}.${key} is required`);
			for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) throw new TypeError(`${what}.${key} is not allowed`);
		}
		function text(value, what, maxLength, allowEmpty = false) {
			if (typeof value !== "string" || !allowEmpty && value.length === 0 || value.length > maxLength) throw new TypeError(`${what} must be a string of at most ${String(maxLength)} characters`);
			return value;
		}
		function integer(value, what) {
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${what} must be a non-negative integer`);
			return value;
		}
		function time(value, what) {
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${what} must be a non-negative number`);
			return value;
		}
		function array(value, what, parse) {
			if (!Array.isArray(value)) throw new TypeError(`${what} must be an array`);
			return value.map((item, index) => parse(item, `${what}[${String(index)}]`));
		}
		function oneOf(value, allowed, what) {
			if (!allowed.includes(value)) throw new TypeError(`${what} must be one of ${allowed.join(", ")}`);
			return value;
		}
		const ATTACHMENT_ID = /^sha256:[0-9a-f]{64}$/;
		const STATUSES = [
			"normal",
			"archived",
			"pending-trash",
			"trash"
		];
		const USAGES = [
			"active",
			"trash-only",
			"unreferenced"
		];
		function parseReference(value, what) {
			const body = record(value, what);
			exactKeys(body, ["sessionId", "status"], ["title", "deletedAt"], what);
			return {
				sessionId: text(body.sessionId, `${what}.sessionId`, 512),
				...body.title === void 0 ? {} : { title: text(body.title, `${what}.title`, 1e3) },
				status: oneOf(body.status, STATUSES, `${what}.status`),
				...body.deletedAt === void 0 ? {} : { deletedAt: time(body.deletedAt, `${what}.deletedAt`) }
			};
		}
		function parseAttachment(value, what) {
			const body = record(value, what);
			exactKeys(body, [
				"kind",
				"attachmentId",
				"names",
				"sizeBytes",
				"missing",
				"usage",
				"references"
			], [
				"storedAt",
				"mediaType",
				"width",
				"height"
			], what);
			if (typeof body.attachmentId !== "string" || !ATTACHMENT_ID.test(body.attachmentId)) throw new TypeError(`${what}.attachmentId must be a sha256 id`);
			if (typeof body.missing !== "boolean") throw new TypeError(`${what}.missing must be a boolean`);
			return {
				kind: oneOf(body.kind, ["image", "file"], `${what}.kind`),
				attachmentId: body.attachmentId,
				names: array(body.names, `${what}.names`, (item, label) => text(item, label, 1e3)),
				sizeBytes: integer(body.sizeBytes, `${what}.sizeBytes`),
				...body.storedAt === void 0 ? {} : { storedAt: time(body.storedAt, `${what}.storedAt`) },
				...body.mediaType === void 0 ? {} : { mediaType: text(body.mediaType, `${what}.mediaType`, 100) },
				...body.width === void 0 ? {} : { width: integer(body.width, `${what}.width`) },
				...body.height === void 0 ? {} : { height: integer(body.height, `${what}.height`) },
				missing: body.missing,
				usage: oneOf(body.usage, USAGES, `${what}.usage`),
				references: array(body.references, `${what}.references`, parseReference)
			};
		}
		function parseBucket(value, what) {
			const body = record(value, what);
			exactKeys(body, ["count", "bytes"], [], what);
			return {
				count: integer(body.count, `${what}.count`),
				bytes: integer(body.bytes, `${what}.bytes`)
			};
		}
		function parseSummary(value) {
			const body = record(value, "summary");
			const buckets = [
				"total",
				"images",
				"files",
				"active",
				"trashOnly",
				"unreferenced"
			];
			const numbers = [
				"missing",
				"requestCacheBytes",
				"liveSessions",
				"trashSessions"
			];
			exactKeys(body, [...buckets, ...numbers], [], "summary");
			return {
				total: parseBucket(body.total, "summary.total"),
				images: parseBucket(body.images, "summary.images"),
				files: parseBucket(body.files, "summary.files"),
				active: parseBucket(body.active, "summary.active"),
				trashOnly: parseBucket(body.trashOnly, "summary.trashOnly"),
				unreferenced: parseBucket(body.unreferenced, "summary.unreferenced"),
				missing: integer(body.missing, "summary.missing"),
				requestCacheBytes: integer(body.requestCacheBytes, "summary.requestCacheBytes"),
				liveSessions: integer(body.liveSessions, "summary.liveSessions"),
				trashSessions: integer(body.trashSessions, "summary.trashSessions")
			};
		}
		function parseProblem(value, what) {
			const body = record(value, what);
			exactKeys(body, [
				"id",
				"where",
				"reason"
			], [], what);
			return {
				id: text(body.id, `${what}.id`, 512),
				where: oneOf(body.where, ["live", "trash"], `${what}.where`),
				reason: text(body.reason, `${what}.reason`, 4e3, true)
			};
		}
		/**
		* Validate a scan result from the wire.
		* @param value - untrusted value.
		* @returns the result.
		*/
		function parseLibraryResult(value) {
			const body = record(value, "result");
			exactKeys(body, [
				"summary",
				"attachments",
				"problems",
				"scannedAt",
				"reread"
			], [], "result");
			const reread = record(body.reread, "result.reread");
			exactKeys(reread, ["live", "trash"], [], "result.reread");
			return {
				summary: parseSummary(body.summary),
				attachments: array(body.attachments, "result.attachments", parseAttachment),
				problems: array(body.problems, "result.problems", parseProblem),
				scannedAt: time(body.scannedAt, "result.scannedAt"),
				reread: {
					live: integer(reread.live, "result.reread.live"),
					trash: integer(reread.trash, "result.reread.trash")
				}
			};
		}
		/**
		* Validate an attachment id: exactly `sha256:` and 64 lowercase hex digits,
		* so it can never name a path.
		* @param value - untrusted value.
		* @returns the id.
		*/
		function parseAttachmentId(value) {
			if (typeof value !== "string" || !ATTACHMENT_ID.test(value)) throw new TypeError("attachmentId must be \"sha256:\" followed by 64 lowercase hex digits");
			return value;
		}
		function parseRevealRequest(value) {
			const body = record(value, "request");
			exactKeys(body, ["kind", "attachmentId"], [], "request");
			return {
				kind: oneOf(body.kind, ["image", "file"], "request.kind"),
				attachmentId: parseAttachmentId(body.attachmentId)
			};
		}
		function parseRevealResult(value) {
			const body = record(value, "result");
			exactKeys(body, ["revealed"], [], "result");
			if (body.revealed !== true) throw new TypeError("result.revealed must be true");
			return { revealed: true };
		}
		function parseRevealAvailability(value) {
			const body = record(value, "result");
			exactKeys(body, ["available", "preview"], [], "result");
			if (typeof body.available !== "boolean" || typeof body.preview !== "boolean") throw new TypeError("result.available and result.preview must be booleans");
			return {
				available: body.available,
				preview: body.preview
			};
		}
		function parsePreviewRequest(value) {
			const body = record(value, "request");
			exactKeys(body, ["attachmentId"], [], "request");
			return { attachmentId: parseAttachmentId(body.attachmentId) };
		}
		function parsePreviewResult(value) {
			const body = record(value, "result");
			exactKeys(body, ["opened"], [], "result");
			if (body.opened !== true) throw new TypeError("result.opened must be true");
			return { opened: true };
		}
		const T = `${ATTACHMENT_LIBRARY_PACKAGE}/types`;
		function descriptor(method, parameters, result, cancellable = false) {
			return {
				id: `${ATTACHMENT_LIBRARY_PACKAGE}#${ATTACHMENT_LIBRARY_NAMESPACE}/${method}`,
				service: ATTACHMENT_LIBRARY_NAMESPACE,
				namespace: ATTACHMENT_LIBRARY_NAMESPACE,
				method,
				invocation: { kind: "direct" },
				parameters: parameters.map((parameter) => ({
					name: parameter.name,
					wire: parameter.name,
					source: "json",
					codec: parameter.codec
				})),
				...cancellable ? { cancellation: { parameter: "signal" } } : {},
				result,
				sourceLocation: {
					file: `${ATTACHMENT_LIBRARY_PACKAGE}/lib/index.js`,
					line: 1,
					column: 1
				}
			};
		}
		//#endregion
		//#region src/client/api.ts
		/** Contribution mounted on `ctx.remote`. */
		const ATTACHMENT_LIBRARY_REMOTE = {
			package: ATTACHMENT_LIBRARY_PACKAGE,
			descriptors: [
				descriptor("scan", [], strict(`${T}#LibraryResult`, parseLibraryResult)),
				descriptor("revealAvailability", [], strict(`${T}#RevealAvailability`, parseRevealAvailability)),
				descriptor("reveal", [{
					name: "request",
					codec: strict(`${T}#RevealRequest`, parseRevealRequest)
				}], strict(`${T}#RevealResult`, parseRevealResult), true),
				descriptor("openInPreview", [{
					name: "request",
					codec: strict(`${T}#PreviewRequest`, parsePreviewRequest)
				}], strict(`${T}#PreviewResult`, parsePreviewResult), true)
			]
		};
		/** Namespace service key under which the Client Remote publishes the methods. */
		const REMOTE_SERVICE = `remote.${ATTACHMENT_LIBRARY_NAMESPACE}`;
		/**
		* Unwrap a Remote result, mapping each failure code to localized copy.
		* @param result - the Remote result.
		* @param t - translate function.
		* @returns the value of a successful call.
		*/
		function unwrap(result, t) {
			if (result.ok) return result.value;
			const { error } = result;
			const details = error.details;
			const reason = typeof details === "object" && details !== null ? Reflect.get(details, "reason") : void 0;
			const code = error.code;
			if (code === "attachment-library/scan-failed") throw new Error(t("error.scanFailed", { reason: typeof reason === "string" ? reason : error.message }));
			if (code === "attachment-library/not-found") throw new Error(t("error.revealNotFound"));
			if (code === "attachment-library/unavailable") throw new Error(t("error.revealUnavailable"));
			if (code === "attachment-library/reveal-failed") throw new Error(t("error.revealFailed", { reason: typeof reason === "string" ? reason : error.message }));
			if (code === "attachment-library/open-failed") throw new Error(t("error.openFailed", { reason: typeof reason === "string" ? reason : error.message }));
			throw new Error(t("error.failed", { message: `${code}: ${error.message}` }));
		}
		/**
		* Format a byte count.
		* @param bytes - byte count.
		* @returns a short human-readable size.
		*/
		function formatBytes(bytes) {
			if (bytes < 1024) return `${String(bytes)} B`;
			const units = [
				"KB",
				"MB",
				"GB",
				"TB"
			];
			let value = bytes / 1024;
			let unit = 0;
			while (value >= 1024 && unit < units.length - 1) {
				value /= 1024;
				unit += 1;
			}
			return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
		}
		const styles = {
			section: {
				display: "flex",
				flexDirection: "column",
				gap: 16,
				padding: "4px 0"
			},
			header: {
				display: "flex",
				alignItems: "flex-start",
				justifyContent: "space-between",
				gap: 12
			},
			title: {
				margin: 0,
				fontSize: 16,
				fontWeight: 600
			},
			muted: {
				margin: "4px 0 0",
				fontSize: 13,
				opacity: .7,
				lineHeight: 1.5
			},
			small: {
				margin: 0,
				fontSize: 12,
				opacity: .65,
				lineHeight: 1.5
			},
			grid: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
				gap: 8,
				margin: 0
			},
			stat: {
				display: "flex",
				flexDirection: "column",
				gap: 2,
				padding: "8px 10px",
				borderRadius: 10,
				border: "1px solid var(--dsw-alias-border-default, rgba(127,127,127,0.25))"
			},
			statLabel: {
				fontSize: 12,
				opacity: .7,
				margin: 0
			},
			statValue: {
				fontSize: 14,
				fontWeight: 600,
				margin: 0
			},
			warning: {
				display: "flex",
				flexDirection: "column",
				gap: 4,
				padding: "8px 12px",
				borderRadius: 10,
				fontSize: 13,
				lineHeight: 1.5,
				border: "1px solid var(--dsw-alias-border-warning, rgba(212,136,6,0.45))"
			},
			toolbar: {
				display: "flex",
				flexWrap: "wrap",
				alignItems: "center",
				gap: 12
			},
			group: {
				display: "flex",
				flexWrap: "wrap",
				alignItems: "center",
				gap: 4
			},
			groupLabel: {
				fontSize: 12,
				opacity: .7,
				marginRight: 4
			},
			list: {
				listStyle: "none",
				margin: 0,
				padding: 0,
				display: "flex",
				flexDirection: "column",
				gap: 8
			},
			row: {
				display: "flex",
				flexDirection: "column",
				gap: 6,
				padding: "10px 12px",
				borderRadius: 10,
				border: "1px solid var(--dsw-alias-border-default, rgba(127,127,127,0.25))"
			},
			rowBody: {
				display: "flex",
				alignItems: "flex-start",
				gap: 12,
				minWidth: 0
			},
			rowText: {
				display: "flex",
				flexDirection: "column",
				gap: 6,
				minWidth: 0,
				flex: 1
			},
			typeIcon: {
				width: 32,
				height: 32,
				flexShrink: 0,
				display: "flex",
				alignItems: "center",
				justifyContent: "center"
			},
			rowHead: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				minWidth: 0
			},
			rowTitle: {
				fontWeight: 500,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
				minWidth: 0,
				flex: 1
			},
			meta: {
				fontSize: 12,
				opacity: .65
			},
			refs: {
				listStyle: "none",
				margin: 0,
				padding: 0,
				display: "flex",
				flexDirection: "column",
				gap: 2
			},
			ref: {
				display: "flex",
				alignItems: "center",
				gap: 6,
				fontSize: 13,
				minWidth: 0
			},
			refTitle: {
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
				minWidth: 0
			},
			iconButton: {
				width: 28,
				padding: 0,
				justifyContent: "center",
				flexShrink: 0
			},
			error: {
				fontSize: 13,
				color: "var(--dsw-alias-text-error, #d4380d)",
				lineHeight: 1.5
			},
			status: {
				fontSize: 13,
				opacity: .75
			}
		};
		const STATUS_KEY = {
			normal: "status.normal",
			archived: "status.archived",
			"pending-trash": "status.pendingTrash",
			trash: "status.trash"
		};
		const STATUS_TONE = {
			normal: "success",
			archived: "neutral",
			"pending-trash": "warning",
			trash: "danger"
		};
		/**
		* Apply the filters and the sort order.
		* @param attachments - every row.
		* @param kind - type filter.
		* @param usage - reference filter.
		* @param sort - sort order.
		* @returns the visible rows.
		*/
		function selectAttachments(attachments, kind, usage, sort) {
			const rows = attachments.filter((item) => (kind === "all" || item.kind === kind) && (usage === "all" || item.usage === usage));
			const byTime = (left, right) => (right.storedAt ?? 0) - (left.storedAt ?? 0);
			return rows.sort((left, right) => sort === "size" ? right.sizeBytes - left.sizeBytes || byTime(left, right) : byTime(left, right) || right.sizeBytes - left.sizeBytes);
		}
		function Stat({ label, bucket, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.stat,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", {
					style: styles.statLabel,
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
					style: {
						...styles.statValue,
						margin: 0
					},
					children: t("summary.bucket", {
						count: bucket.count,
						size: formatBytes(bucket.bytes)
					})
				})]
			});
		}
		function Filter({ label, value, options, onChange }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				role: "group",
				"aria-label": label,
				style: styles.group,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles.groupLabel,
					children: label
				}), options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
					active: option.value === value,
					"aria-pressed": option.value === value,
					onClick: () => {
						onChange(option.value);
					},
					children: option.label
				}, option.value))]
			});
		}
		function TypeIcon({ item, name }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: styles.typeIcon,
				"aria-hidden": "true",
				children: item.kind === "image" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.FileTypeIcon, {
					kind: "image",
					size: 28
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.FileTypeIcon, {
					path: name,
					size: 28
				})
			});
		}
		/**
		* Icon-only row action ("Show in Finder", "Open in Preview"). A failure is
		* shown under the row and cleared by the next attempt.
		*/
		function ActionButton({ label, icon, run, onError }) {
			const [busy, setBusy] = (0, react.useState)(false);
			const click = () => {
				setBusy(true);
				onError(null);
				run().catch((reason) => {
					onError(reason instanceof Error ? reason.message : String(reason));
				}).finally(() => {
					setBusy(false);
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				size: "sm",
				variant: "ghost",
				icon,
				"aria-label": label,
				title: label,
				style: styles.iconButton,
				disabled: busy,
				onClick: click
			});
		}
		function referenceTitle(reference, t) {
			return reference.title ?? t("ref.untitled", { id: reference.sessionId.slice(0, 8) });
		}
		function AttachmentRow({ item, dateFormat, actions, t }) {
			const { reveal, openInPreview } = actions;
			const [revealError, setRevealError] = (0, react.useState)(null);
			const name = item.names[0] ?? (item.kind === "image" ? t("item.unnamedImage") : t("item.unnamedFile"));
			const meta = [formatBytes(item.sizeBytes)];
			if (item.width !== void 0 && item.height !== void 0) meta.push(t("item.dimensions", {
				width: item.width,
				height: item.height
			}));
			if (item.mediaType !== void 0) meta.push(item.mediaType);
			if (item.storedAt !== void 0) meta.push(t("item.storedAt", { time: dateFormat.format(new Date(item.storedAt)) }));
			const usageKey = item.usage === "active" ? "usage.active" : item.usage === "trash-only" ? "usage.trashOnly" : "usage.unreferenced";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
				style: styles.row,
				"aria-label": name,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles.rowBody,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TypeIcon, {
						item,
						name
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.rowText,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles.rowHead,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
										tone: "outline",
										children: item.kind === "image" ? t("item.image") : t("item.file")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: styles.rowTitle,
										title: item.names.join("\n") || item.attachmentId,
										children: name
									}),
									item.missing && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
										tone: "danger",
										children: t("item.missing")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
										tone: item.usage === "active" ? "info" : "warning",
										children: t(usageKey)
									}),
									openInPreview !== void 0 && item.kind === "image" && !item.missing && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
										label: t("item.openPreview"),
										icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRightUpOutlineRegular, { size: 16 }),
										run: () => openInPreview({ attachmentId: item.attachmentId }),
										onError: setRevealError
									}),
									reveal !== void 0 && !item.missing && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
										label: t("item.reveal"),
										icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenOutlineRegular, { size: 16 }),
										run: () => reveal({
											kind: item.kind,
											attachmentId: item.attachmentId
										}),
										onError: setRevealError
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.meta,
								children: meta.join(" · ")
							}),
							revealError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								role: "alert",
								style: styles.error,
								children: revealError
							}),
							item.names.length > 1 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.meta,
								children: t("item.otherNames", { count: item.names.length - 1 })
							}),
							item.references.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.meta,
								children: t("item.noReferences")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								style: styles.refs,
								"aria-label": t("item.references"),
								children: item.references.map((reference) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									style: styles.ref,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
										tone: STATUS_TONE[reference.status],
										children: t(STATUS_KEY[reference.status])
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: styles.refTitle,
										title: reference.sessionId,
										children: referenceTitle(reference, t)
									})]
								}, `${reference.status}:${reference.sessionId}:${String(reference.deletedAt ?? "")}`))
							})
						]
					})]
				})
			});
		}
		/**
		* The Attachment library settings page.
		* @param props - the Remote hop and the translate function.
		* @returns the page.
		*/
		function LibrarySection({ scan, desktopActions, reveal, openInPreview, t }) {
			const [offered, setOffered] = (0, react.useState)({
				reveal: false,
				preview: false
			});
			(0, react.useEffect)(() => {
				let live = true;
				desktopActions?.().then((next) => {
					if (live) setOffered(next);
				}, () => {
					if (live) setOffered({
						reveal: false,
						preview: false
					});
				});
				return () => {
					live = false;
				};
			}, [desktopActions]);
			const actions = (0, react.useMemo)(() => ({
				...offered.reveal && reveal !== void 0 ? { reveal } : {},
				...offered.preview && openInPreview !== void 0 ? { openInPreview } : {}
			}), [
				offered,
				reveal,
				openInPreview
			]);
			const [result, setResult] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [kind, setKind] = (0, react.useState)("all");
			const [usage, setUsage] = (0, react.useState)("all");
			const [sort, setSort] = (0, react.useState)("time");
			const [limit, setLimit] = (0, react.useState)(100);
			const reload = (0, react.useCallback)(async () => {
				setBusy(true);
				setError(null);
				try {
					setResult(await scan());
				} catch (reason) {
					setError(reason instanceof Error ? reason.message : String(reason));
				} finally {
					setBusy(false);
				}
			}, [scan]);
			(0, react.useEffect)(() => {
				reload();
			}, [reload]);
			(0, react.useEffect)(() => {
				setLimit(100);
			}, [
				kind,
				usage,
				sort
			]);
			const visible = (0, react.useMemo)(() => result === null ? [] : selectAttachments(result.attachments, kind, usage, sort), [
				result,
				kind,
				usage,
				sort
			]);
			const dateFormat = new Intl.DateTimeFormat(void 0, {
				dateStyle: "medium",
				timeStyle: "short"
			});
			const summary = result?.summary;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: styles.section,
				"aria-label": t("section.title"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.header,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
							style: styles.title,
							children: t("section.title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: styles.muted,
							children: t("section.desc")
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "ghost",
							icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutlineRegular, { size: 16 }),
							"aria-label": t("section.refresh"),
							title: t("section.refresh"),
							style: styles.iconButton,
							disabled: busy,
							onClick: () => {
								reload();
							}
						})]
					}),
					error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						role: "alert",
						style: styles.error,
						children: error
					}),
					busy && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						role: "status",
						style: styles.status,
						children: result === null ? t("section.loading") : t("section.scanning")
					}),
					summary !== void 0 && result !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
							style: styles.grid,
							"aria-label": t("summary.label"),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
									label: t("summary.total"),
									bucket: summary.total,
									t
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
									label: t("summary.images"),
									bucket: summary.images,
									t
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
									label: t("summary.files"),
									bucket: summary.files,
									t
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
									label: t("summary.active"),
									bucket: summary.active,
									t
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
									label: t("summary.trashOnly"),
									bucket: summary.trashOnly,
									t
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
									label: t("summary.unreferenced"),
									bucket: summary.unreferenced,
									t
								}),
								summary.missing > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: styles.stat,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", {
										style: styles.statLabel,
										children: t("summary.missing")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
										style: {
											...styles.statValue,
											margin: 0
										},
										children: summary.missing
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: styles.stat,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", {
										style: styles.statLabel,
										children: t("summary.cache")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
										style: {
											...styles.statValue,
											margin: 0
										},
										children: formatBytes(summary.requestCacheBytes)
									})]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: styles.small,
							children: t("section.scanned", {
								time: dateFormat.format(new Date(result.scannedAt)),
								live: result.reread.live,
								trash: result.reread.trash
							})
						}),
						result.problems.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							role: "note",
							style: styles.warning,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("problems.title", { count: result.problems.length }) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("problems.desc") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
									style: {
										...styles.refs,
										fontSize: 12,
										opacity: .8
									},
									children: result.problems.map((problem) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
										problem.where === "live" ? t("problems.live") : t("problems.trash"),
										" ",
										problem.id,
										": ",
										problem.reason
									] }, `${problem.where}:${problem.id}`))
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.toolbar,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Filter, {
									label: t("filter.kind"),
									value: kind,
									onChange: setKind,
									options: [
										{
											value: "all",
											label: t("filter.kindAll")
										},
										{
											value: "image",
											label: t("filter.kindImage")
										},
										{
											value: "file",
											label: t("filter.kindFile")
										}
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Filter, {
									label: t("filter.usage"),
									value: usage,
									onChange: setUsage,
									options: [
										{
											value: "all",
											label: t("filter.usageAll")
										},
										{
											value: "active",
											label: t("filter.usageActive")
										},
										{
											value: "trash-only",
											label: t("filter.usageTrash")
										},
										{
											value: "unreferenced",
											label: t("filter.usageNone")
										}
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Filter, {
									label: t("sort.label"),
									value: sort,
									onChange: setSort,
									options: [{
										value: "time",
										label: t("sort.time")
									}, {
										value: "size",
										label: t("sort.size")
									}]
								})
							]
						}),
						result.attachments.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: styles.muted,
							children: t("section.empty")
						}),
						result.attachments.length > 0 && visible.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: styles.muted,
							children: t("section.noMatch")
						}),
						visible.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							style: styles.list,
							"aria-label": t("list.label"),
							children: visible.slice(0, limit).map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AttachmentRow, {
								item,
								dateFormat,
								actions,
								t
							}, `${item.kind}:${item.attachmentId}`))
						}),
						visible.length > limit && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "outline",
							onClick: () => {
								setLimit(limit + 100);
							},
							children: t("list.more", { count: visible.length - limit })
						})
					] })
				]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** Client copy for the `attachmentLibrary` locale namespace. */
		const zh = {
			"section.nav": "附件库",
			"section.title": "附件库",
			"section.desc": "查看本机保存的所有图片和文件附件、它们占用的空间，以及哪些对话仍在使用它们。这里只读，不会修改或删除任何文件。",
			"section.refresh": "重新统计",
			"section.loading": "正在统计附件引用…首次打开需要读取全部会话记录，可能较慢。",
			"section.empty": "没有保存任何附件",
			"section.noMatch": "没有符合筛选条件的附件",
			"section.scanned": "统计于 {time}：读取了 {live} 个会话记录和 {trash} 个回收站会话记录，其余未变化的来自缓存。",
			"summary.total": "附件总数",
			"summary.images": "图片",
			"summary.files": "文件",
			"summary.active": "被现存对话使用",
			"summary.trashOnly": "只被回收站里的对话使用",
			"summary.unreferenced": "无任何对话引用",
			"summary.missing": "被引用但文件缺失",
			"summary.cache": "可再生的缩放缓存",
			"summary.bucket": "{count} 个 · {size}",
			"summary.label": "附件统计",
			"problems.title": "有 {count} 项会话记录未能完整读取",
			"problems.desc": "这些记录中的引用没有计入，所以“无任何对话引用”和“只被回收站里的对话使用”的统计可能偏多。",
			"problems.live": "会话",
			"problems.trash": "回收站",
			"filter.kind": "类型",
			"filter.kindAll": "全部",
			"filter.kindImage": "仅图片",
			"filter.kindFile": "仅文件",
			"filter.usage": "引用情况",
			"filter.usageAll": "全部",
			"filter.usageActive": "现存对话",
			"filter.usageTrash": "仅被回收站引用",
			"filter.usageNone": "无人引用",
			"sort.label": "排序",
			"sort.time": "按时间",
			"sort.size": "按大小",
			"list.label": "附件列表",
			"list.more": "显示更多（还有 {count} 个）",
			"item.image": "图片",
			"item.file": "文件",
			"item.unnamedImage": "未命名图片",
			"item.unnamedFile": "未命名文件",
			"item.otherNames": "另有 {count} 个文件名",
			"item.dimensions": "{width} × {height}",
			"item.storedAt": "存入 {time}",
			"item.missing": "文件缺失",
			"item.noReferences": "没有对话引用此附件",
			"item.references": "引用它的对话",
			"item.reveal": "在访达中显示",
			"item.openPreview": "用预览打开",
			"usage.active": "使用中",
			"usage.trashOnly": "仅回收站",
			"usage.unreferenced": "无人引用",
			"status.normal": "正常",
			"status.archived": "已归档",
			"status.pendingTrash": "等待移入回收站",
			"status.trash": "在回收站",
			"ref.untitled": "未命名对话（{id}）",
			"section.scanning": "正在重新统计…",
			"error.revealNotFound": "附件库中找不到这个文件，可能已被移除。请重新统计。",
			"error.revealUnavailable": "这台主机无法在文件管理器中显示文件。",
			"error.revealFailed": "无法在访达中显示：{reason}",
			"error.openFailed": "无法用预览打开：{reason}",
			"error.scanFailed": "统计失败，未做任何改动：{reason}",
			"error.failed": "读取失败：{message}"
		};
		const en = {
			"section.nav": "Attachment library",
			"section.title": "Attachment library",
			"section.desc": "Every image and file attachment stored on this machine, the space it takes, and which conversations still use it. This page is read-only: it never changes or deletes a file.",
			"section.refresh": "Rescan",
			"section.loading": "Counting attachment references… The first scan reads every session log and can take a while.",
			"section.empty": "No attachments are stored",
			"section.noMatch": "No attachments match the filters",
			"section.scanned": "Scanned {time}: read {live} session log(s) and {trash} trashed session log(s); unchanged ones came from the cache.",
			"summary.total": "All attachments",
			"summary.images": "Images",
			"summary.files": "Files",
			"summary.active": "Used by existing conversations",
			"summary.trashOnly": "Used only by conversations in the trash",
			"summary.unreferenced": "Not used by any conversation",
			"summary.missing": "Referenced but missing",
			"summary.cache": "Regenerable resize cache",
			"summary.bucket": "{count} · {size}",
			"summary.label": "Attachment totals",
			"problems.title": "{count} session log item(s) could not be read in full",
			"problems.desc": "References in them are not counted, so “not used by any conversation” and “used only by the trash” may be too high.",
			"problems.live": "Session",
			"problems.trash": "Trash",
			"filter.kind": "Type",
			"filter.kindAll": "All",
			"filter.kindImage": "Images",
			"filter.kindFile": "Files",
			"filter.usage": "References",
			"filter.usageAll": "All",
			"filter.usageActive": "Existing",
			"filter.usageTrash": "Trash only",
			"filter.usageNone": "Unused",
			"sort.label": "Sort",
			"sort.time": "By time",
			"sort.size": "By size",
			"list.label": "Attachments",
			"list.more": "Show more ({count} left)",
			"item.image": "Image",
			"item.file": "File",
			"item.unnamedImage": "Unnamed image",
			"item.unnamedFile": "Unnamed file",
			"item.otherNames": "{count} more file name(s)",
			"item.dimensions": "{width} × {height}",
			"item.storedAt": "Stored {time}",
			"item.missing": "Missing",
			"item.noReferences": "No conversation references this attachment",
			"item.references": "Conversations using it",
			"item.reveal": "Show in Finder",
			"item.openPreview": "Open in Preview",
			"usage.active": "In use",
			"usage.trashOnly": "Trash only",
			"usage.unreferenced": "Unused",
			"status.normal": "Active",
			"status.archived": "Archived",
			"status.pendingTrash": "Moving to trash",
			"status.trash": "In trash",
			"ref.untitled": "Untitled conversation ({id})",
			"section.scanning": "Rescanning…",
			"error.revealNotFound": "This file is no longer in the attachment store. Rescan to update the list.",
			"error.revealUnavailable": "This Host cannot show files in a file manager.",
			"error.revealFailed": "Could not show the file in Finder: {reason}",
			"error.openFailed": "Could not open the image in Preview: {reason}",
			"error.scanFailed": "The scan failed; nothing was changed: {reason}",
			"error.failed": "Reading failed: {message}"
		};
		//#endregion
		//#region src/client/index.tsx
		/** Locale namespace of this plugin's copy. */
		const NS = "attachmentLibrary";
		/** Client plugin name. */
		const name = "dsh-plugin-attachment-library/client";
		/** Client services this plugin needs. */
		const inject = [
			"slots",
			"locale",
			"remote"
		];
		/**
		* Install the Remote contribution and the settings page.
		* @param ctx - Client root Context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "attachment-library: dictionaries");
			const t = ctx.locale.bind(NS);
			const mounted = ctx.remote.$mount(ATTACHMENT_LIBRARY_REMOTE);
			ctx.effect(() => () => {
				mounted.then((dispose) => dispose());
			}, "attachment-library: Remote methods");
			const remote = async () => {
				await mounted;
				return ctx.get(REMOTE_SERVICE);
			};
			const scan = async () => unwrap(await (await remote()).scan(), t);
			const reveal = async (request) => {
				unwrap(await (await remote()).reveal(request), t);
			};
			const openInPreview = async (request) => {
				unwrap(await (await remote()).openInPreview(request), t);
			};
			const none = {
				reveal: false,
				preview: false
			};
			const desktopActions = async () => {
				if (!ctx.remote.$host.isLoopback) return none;
				const host = await (await remote()).revealAvailability();
				if (!host.ok || !host.value.available) return none;
				const session = ctx.get("remote.session");
				if (typeof session?.canOpenWorkspacePath === "function") {
					const official = await session.canOpenWorkspacePath();
					if (!official.ok || !official.value) return none;
				}
				return {
					reveal: true,
					preview: host.value.preview
				};
			};
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "attachment-library",
				order: 75,
				label: () => t("section.nav"),
				locale: NS
			}, () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LibrarySection, {
				scan,
				desktopActions,
				reveal,
				openInPreview,
				t
			})));
		}
		//#endregion
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
