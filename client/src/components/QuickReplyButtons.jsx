export default function QuickReplyButtons({ replies, onSelect }) {
  return (
    <div className="px-4 py-2 flex flex-wrap gap-2" role="group" aria-label="Quick reply options">
      {replies.map((reply, i) => (
        <button
          key={i}
          onClick={() => onSelect(reply.value)}
          className="border border-cushion-500 text-cushion-700 rounded-full px-4 py-3 text-sm hover:bg-cushion-50 focus:ring-2 focus:ring-cushion-500 focus:outline-none transition-colors"
        >
          {reply.label}
        </button>
      ))}
    </div>
  );
}
