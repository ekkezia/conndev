import { useEffect, useMemo, useRef, useState } from 'react';
import { useWandCursor } from '../hooks/use-wand-cursor';
import WandCursorSVG from './wand-cursor-svg';

const MAX_NAME_LEN = 5;
const LETTERS = ['', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];
const SAVE_AFTER_EDIT_COOLDOWN_MS = 450;

export default function PostGameOverlay({
	cursor,
	canvasRect,
	isDrawActive = true,
	song,
	score,
	playedAtMs,
	onSubmit,
}) {
	const [nameSlots, setNameSlots] = useState(Array(MAX_NAME_LEN).fill(''));
	const [hoveredButtonId, setHoveredButtonId] = useState(null);
	const buttonRefs = useRef(new Map());
	const saveButtonRef = useRef(null);
	const lastEditAtRef = useRef(0);
	const {
		activeCursor,
		trailItems,
		onMouseMove,
		onMouseLeave,
		clickKey,
		triggerClick,
	} = useWandCursor(cursor, canvasRect, {
		enableTrail: true,
		smoothWandCursor: true,
		smoothFactor: 0.28,
	});

	const name = useMemo(() => nameSlots.join(''), [nameSlots]);
	const canSubmit = useMemo(() => name.trim().length > 0, [name]);
	const playedAtLabel = useMemo(() => {
		const d = new Date(playedAtMs ?? Date.now());
		if (Number.isNaN(d.getTime())) return '';
		return d.toLocaleString([], {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
		});
	}, [playedAtMs]);

	const cycleSlot = (slotIndex, dir) => {
		lastEditAtRef.current = Date.now();
		setNameSlots((prev) => {
			const next = [...prev];
			const current = next[slotIndex] ?? '';
			const currentIdx = Math.max(0, LETTERS.indexOf(current));
			const targetIdx = (currentIdx + dir + LETTERS.length) % LETTERS.length;
			next[slotIndex] = LETTERS[targetIdx];
			return next;
		});
	};

	const backspace = () => {
		lastEditAtRef.current = Date.now();
		setNameSlots((prev) => {
			const next = [...prev];
			for (let i = next.length - 1; i >= 0; i -= 1) {
				if (next[i]) {
					next[i] = '';
					break;
				}
			}
			return next;
		});
	};
	const clear = () => {
		lastEditAtRef.current = Date.now();
		setNameSlots(Array(MAX_NAME_LEN).fill(''));
	};

	useEffect(() => {
		if (!activeCursor) {
			setHoveredButtonId(null);
			return;
		}

		let hoveredId = null;
		for (const [id, el] of buttonRefs.current.entries()) {
			if (!el) continue;
			const rect = el.getBoundingClientRect();
			const inside =
				activeCursor.x >= rect.left &&
				activeCursor.x <= rect.right &&
				activeCursor.y >= rect.top &&
				activeCursor.y <= rect.bottom;
			if (inside) {
				hoveredId = id;
				break;
			}
		}
		setHoveredButtonId(hoveredId);
	}, [activeCursor]);

	const bindButtonRef = (id) => (el) => {
		if (!el) {
			buttonRefs.current.delete(id);
			return;
		}
		buttonRefs.current.set(id, el);
	};

	const isPointInsideElement = (el, x, y) => {
		if (!el || !Number.isFinite(x) || !Number.isFinite(y)) return false;
		const rect = el.getBoundingClientRect();
		return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
	};

	const handleSave = (event) => {
		if (!canSubmit) return;
		if (Date.now() - lastEditAtRef.current < SAVE_AFTER_EDIT_COOLDOWN_MS) return;
		const pointX =
			Number.isFinite(event?.clientX) ? event.clientX : activeCursor?.x;
		const pointY =
			Number.isFinite(event?.clientY) ? event.clientY : activeCursor?.y;
		const isOverSaveByCursor = hoveredButtonId === 'key-save';
		const isOverSaveByPoint = isPointInsideElement(
			saveButtonRef.current,
			pointX,
			pointY,
		);
		// Require hovered state as source of truth to avoid stale coordinate clicks.
		const isOverSave = isOverSaveByCursor && isOverSaveByPoint;
		if (!isOverSave) return;
		onSubmit(name.trim());
	};

	return (
		<div
			className="absolute inset-0 z-50 flex items-center justify-center bg-cola-brown/84 backdrop-blur-md"
			onMouseMove={onMouseMove}
			onMouseLeave={onMouseLeave}
			onClick={triggerClick}
		>
			<svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none">
				<WandCursorSVG
					activeCursor={activeCursor}
					trailItems={trailItems}
					clickKey={clickKey}
					isDrawActive={isDrawActive}
				/>
			</svg>

			<div className="w-full max-w-6xl px-6">
				<div
					className="rounded-2xl border border-cream-soda/55 bg-gradient-to-br from-[#ff4fa3]/46 via-[#ff8a86]/34 to-[#ffb43b]/42 p-6 md:p-8 shadow-2xl"
					style={{
						background:
							'linear-gradient(135deg, rgba(255,79,163,0.5) 0%, rgba(255,138,134,0.5) 50%, rgba(255,180,59,0.5) 100%)',
					}}
				>
					<div className="flex flex-col md:flex-row md:items-end md:justify-between gap-2">
						<div>
							<h2 className="text-cream-soda font-mono text-4xl font-bold tracking-tight">
								song complete
							</h2>
							<p className="text-cream-soda/70 font-mono text-lg mt-1">
								{song?.title} · {song?.artist}
							</p>
							<p className="text-cream-soda/60 font-mono text-xs mt-1">
								played at: {playedAtLabel}
							</p>
						</div>
						<p className="text-cream-soda font-mono text-2xl md:text-3xl font-bold">
							{score} pts
						</p>
					</div>

					<div className="mt-6">
						<p className="text-cream-soda/80 font-mono text-lg mb-2">
							pick up to 5 letters
						</p>
						<div className="min-h-[64px] rounded-xl border border-cream-soda/45 bg-gradient-to-r from-[#ff4fa3]/20 to-[#ffb43b]/24 px-4 py-3 text-cream-soda font-mono text-3xl tracking-wider flex items-center">
							{name || (
								<span className="text-cream-soda/35 text-xl tracking-normal">
									YOUR NAME
								</span>
							)}
						</div>
					</div>

					<div className="mt-6 flex flex-col gap-5 w-full max-w-5xl mx-auto">
						<div className="grid grid-cols-5 gap-3 md:gap-4">
							{Array.from({ length: MAX_NAME_LEN }, (_, idx) => (
								<div
									key={`slot-${idx}`}
									className="rounded-xl border border-cream-soda/40 bg-black/25 p-2 md:p-3 flex flex-col items-center gap-2"
								>
										<button
											type="button"
											ref={bindButtonRef(`slot-${idx}-up`)}
											onClick={() => cycleSlot(idx, 1)}
											className={`
                      beat-menu-option w-full min-h-[88px] text-cream-soda px-2 py-5 md:py-6 rounded-xl font-mono text-5xl md:text-6xl leading-none
                      ${hoveredButtonId === `slot-${idx}-up` ? 'is-selected' : ''}
                    `}
										>
										▲
									</button>
									<div className="w-full min-h-[72px] rounded-lg border border-cream-soda/45 bg-gradient-to-r from-[#ff4fa3]/16 to-[#ffb43b]/18 flex items-center justify-center text-cream-soda font-mono text-5xl md:text-6xl leading-none">
										{nameSlots[idx] || '·'}
									</div>
										<button
											type="button"
											ref={bindButtonRef(`slot-${idx}-down`)}
											onClick={() => cycleSlot(idx, -1)}
											className={`
                      beat-menu-option w-full min-h-[88px] text-cream-soda px-2 py-5 md:py-6 rounded-xl font-mono text-5xl md:text-6xl leading-none
                      ${hoveredButtonId === `slot-${idx}-down` ? 'is-selected' : ''}
                    `}
										>
										▼
									</button>
								</div>
							))}
						</div>
						<div className="flex flex-wrap gap-5 pt-2 justify-center items-center">
							<button
								type="button"
								ref={bindButtonRef('key-delete')}
								onClick={backspace}
								className={`
                  beat-menu-option text-cream-soda px-8 py-5 rounded-xl font-mono text-3xl min-w-[13rem]
                  ${hoveredButtonId === 'key-delete' ? 'is-selected' : ''}
                `}
							>
								BACK
							</button>
							<button
								type="button"
								ref={bindButtonRef('key-clear')}
								onClick={clear}
								className={`
                  beat-menu-option text-cream-soda px-8 py-5 rounded-xl font-mono text-3xl min-w-[13rem]
                  ${hoveredButtonId === 'key-clear' ? 'is-selected' : ''}
                `}
							>
								CLEAR
							</button>
							<button
								type="button"
								disabled={!canSubmit}
								ref={(el) => {
									bindButtonRef('key-save')(el);
									saveButtonRef.current = el;
								}}
								onClick={handleSave}
								className={`
                  beat-menu-start rounded-xl px-10 py-5 font-mono text-3xl font-bold uppercase min-w-[16rem]
                  ${canSubmit ? 'is-ready text-cream-soda cursor-pointer !bg-fuchsia-600 hover:!bg-fuchsia-500 !border-fuchsia-300' : 'is-disabled text-cream-soda/70 cursor-not-allowed !bg-fuchsia-900/40'}
                  ${hoveredButtonId === 'key-save' ? ' is-selected' : ''}
                `}
							>
								commemorate ur magic
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
