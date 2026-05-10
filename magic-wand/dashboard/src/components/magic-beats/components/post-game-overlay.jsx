import { useEffect, useMemo, useRef, useState } from 'react';
import { useWandCursor } from '../hooks/use-wand-cursor';
import WandCursorSVG from './wand-cursor-svg';

const MAX_NAME_LEN = 12;

const KEY_ROWS = [
	['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
	['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
	['Z', 'X', 'C', 'V', 'B', 'N', 'M'],
];

export default function PostGameOverlay({
	cursor,
	canvasRect,
	isDrawActive = true,
	song,
	score,
	playedAtMs,
	onSubmit,
}) {
	const [name, setName] = useState('');
	const [hoveredButtonId, setHoveredButtonId] = useState(null);
	const buttonRefs = useRef(new Map());
	const {
		activeCursor,
		trailItems,
		onMouseMove,
		onMouseLeave,
		clickKey,
		triggerClick,
	} = useWandCursor(cursor, canvasRect);

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

	const appendChar = (ch) => {
		setName((prev) => {
			if (prev.length >= MAX_NAME_LEN) return prev;
			return prev + ch;
		});
	};

	const backspace = () => setName((prev) => prev.slice(0, -1));
	const clear = () => setName('');

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
							type your name
						</p>
						<div className="min-h-[64px] rounded-xl border border-cream-soda/45 bg-gradient-to-r from-[#ff4fa3]/20 to-[#ffb43b]/24 px-4 py-3 text-cream-soda font-mono text-3xl tracking-wider flex items-center">
							{name || (
								<span className="text-cream-soda/35 text-xl tracking-normal">
									YOUR NAME
								</span>
							)}
						</div>
					</div>

					<div className="mt-6 flex flex-col gap-4 w-full max-w-5xl mx-auto">
						{KEY_ROWS.map((row, idx) => (
							<div
								key={idx}
								className="flex flex-wrap gap-3 justify-center items-center"
							>
								{row.map((ch) => (
									<button
										key={ch}
										type="button"
										ref={bindButtonRef(`key-${ch}`)}
										onClick={() => appendChar(ch)}
										className={`
                      beat-menu-option text-cream-soda px-5 py-3 rounded-xl font-mono text-2xl min-w-[4.4rem]
                      ${hoveredButtonId === `key-${ch}` ? 'is-selected' : ''}
                    `}
									>
										{ch}
									</button>
								))}
							</div>
						))}
						<div className="flex flex-wrap gap-3 pt-2 justify-center items-center">
							<button
								type="button"
								ref={bindButtonRef('key-space')}
								onClick={() => appendChar(' ')}
								className={`
                  beat-menu-option text-cream-soda px-6 py-3 rounded-xl font-mono text-xl min-w-[9rem]
                  ${hoveredButtonId === 'key-space' ? 'is-selected' : ''}
                `}
							>
								SPACE
							</button>
							<button
								type="button"
								ref={bindButtonRef('key-delete')}
								onClick={backspace}
								className={`
                  beat-menu-option text-cream-soda px-6 py-3 rounded-xl font-mono text-xl min-w-[9rem]
                  ${hoveredButtonId === 'key-delete' ? 'is-selected' : ''}
                `}
							>
								DELETE
							</button>
							<button
								type="button"
								ref={bindButtonRef('key-clear')}
								onClick={clear}
								className={`
                  beat-menu-option text-cream-soda px-6 py-3 rounded-xl font-mono text-xl min-w-[9rem]
                  ${hoveredButtonId === 'key-clear' ? 'is-selected' : ''}
                `}
							>
								CLEAR
							</button>
							<button
								type="button"
								disabled={!canSubmit}
								ref={bindButtonRef('key-save')}
								onClick={() => canSubmit && onSubmit(name.trim())}
								className={`
                  beat-menu-start rounded-xl px-8 py-3 font-mono text-xl font-bold uppercase min-w-[12rem]
                  ${canSubmit ? 'is-ready text-cream-soda cursor-pointer' : 'is-disabled text-cream-soda/70 cursor-not-allowed'}
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
