import type { ScreenItem } from "./data";

function Text({
  x,
  y,
  children,
  size = 16,
  fill = "#768079",
  weight = 400,
}: {
  x: number;
  y: number;
  children: React.ReactNode;
  size?: number;
  fill?: string;
  weight?: number;
}) {
  return (
    <text x={x} y={y} fill={fill} fontSize={size} fontWeight={weight}>
      {children}
    </text>
  );
}
function Rect({
  x,
  y,
  w,
  h,
  fill = "#fff",
  stroke = "none",
  r = 8,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  r?: number;
}) {
  return (
    <rect x={x} y={y} width={w} height={h} rx={r} fill={fill} stroke={stroke} />
  );
}
function ProductHeader({ active = "Orders" }: { active?: string }) {
  return (
    <>
      <Rect x={0} y={0} w={234} h={960} fill="#1f332e" r={0} />
      <Rect x={26} y={30} w={34} h={34} fill="#e2ad74" r={9} />
      <path
        d="m35 46 8-7 8 7-8 7-8-7Z"
        stroke="#26372e"
        fill="none"
        strokeWidth={2}
      />
      <Text x={73} y={54} fill="#f4f5ec" weight={600} size={24}>
        northstar
      </Text>
      <Text x={28} y={115} fill="#91a49b" size={12}>
        CUSTOMER WORKSPACE
      </Text>
      {["Overview", "Orders", "Customers", "Reports"].map((n, i) => (
        <g key={n}>
          {active === n && (
            <Rect x={16} y={137 + i * 53} w={202} h={43} fill="#355248" r={7} />
          )}
          <rect
            x={31}
            y={151 + i * 53}
            width={14}
            height={14}
            rx={3}
            fill="none"
            stroke={active === n ? "#e7b780" : "#93a49c"}
            strokeWidth={1.5}
          />
          <Text
            x={59}
            y={164 + i * 53}
            fill={active === n ? "#fff8eb" : "#a7b7ae"}
            size={16}
            weight={active === n ? 600 : 400}
          >
            {n}
          </Text>
        </g>
      ))}
      <line x1={24} x2={210} y1={851} y2={851} stroke="#3e5147" />
      <circle cx={42} cy={900} r={18} fill="#4f6b5a" />
      <Text x={30} y={905} fill="#ecf0e5" size={12}>
        JD
      </Text>
      <Text x={73} y={896} fill="#e1e9e0" size={14} weight={500}>
        Jamie Davis
      </Text>
      <Text x={73} y={916} fill="#8ba194" size={12}>
        Acme Studio
      </Text>
      <Rect x={235} y={0} w={1205} h={76} fill="#fff" r={0} />
      <line x1={235} x2={1440} y1={76} y2={76} stroke="#e6e9e4" />
      <Text x={279} y={47} size={15}>
        Workspace
      </Text>
      <Text x={386} y={47} fill="#b7bfb7">
        /
      </Text>
      <Text x={411} y={47} fill="#34453b" size={15}>
        {active}
      </Text>
      <circle cx={1368} cy={38} r={17} fill="#eef1e8" />
      <Text x={1357} y={43} size={11} fill="#435443">
        JD
      </Text>
    </>
  );
}

export default function SampleScreen({
  screen,
  miniature = false,
}: {
  screen: ScreenItem;
  miniature?: boolean;
}) {
  if (screen.url)
    return (
      <img className="custom-screenshot" src={screen.url} alt={screen.title} />
    );
  return (
    <svg
      className="sample-screen"
      viewBox="0 0 1440 960"
      role="img"
      aria-label={`${screen.title} — synthetic Northstar screen`}
      style={{ fontFamily: "Inter Variable, Inter, sans-serif" }}
    >
      <Rect x={0} y={0} w={1440} h={960} fill="#f5f6f2" r={0} />
      {screen.kind === "login" ? (
        <>
          <Rect x={750} y={0} w={690} h={960} fill="#e5e8dc" r={0} />
          <circle
            cx={1100}
            cy={480}
            r={270}
            stroke="#c7d0bb"
            strokeWidth={1}
            fill="none"
          />
          <circle
            cx={1100}
            cy={480}
            r={200}
            stroke="#c7d0bb"
            strokeWidth={1}
            fill="none"
          />
          <circle
            cx={1100}
            cy={480}
            r={130}
            stroke="#c7d0bb"
            strokeWidth={1}
            fill="none"
          />
          <path
            d="m955 402 145-84 145 84v168l-145 84-145-84V402Z"
            fill="#345349"
          />
          <path
            d="m955 402 145 83 145-83m-145 83v169"
            stroke="#85a38a"
            strokeWidth={2}
            fill="none"
          />
          <Rect x={1065} y={366} w={125} h={74} fill="#e3b680" r={6} />
          <Text x={1081} y={409} size={16} weight={600} fill="#3b4635">
            Make it move.
          </Text>
          <Text x={871} y={794} size={32} weight={500} fill="#304b3a">
            A clearer view of every order.
          </Text>
          <Text x={905} y={831} size={17} fill="#6a7d65">
            Your products, people and possibilities. Connected.
          </Text>
          <Text x={115} y={104} size={28} weight={650} fill="#294b3d">
            ◇ northstar
          </Text>
          <Text x={115} y={295} size={40} weight={600} fill="#263d30">
            Good to see you again.
          </Text>
          <Text x={115} y={336} size={18}>
            Sign in to your customer workspace.
          </Text>
          <Text x={115} y={409} fill="#38473a" size={15} weight={500}>
            Work email
          </Text>
          <Rect x={115} y={427} w={510} h={57} stroke="#d5dbd0" />
          <Text x={134} y={462} size={16}>
            jamie@acmestudio.com
          </Text>
          <Text x={115} y={526} fill="#38473a" size={15} weight={500}>
            Password
          </Text>
          <Rect x={115} y={544} w={510} h={57} stroke="#d5dbd0" />
          <Text x={134} y={581} size={20} fill="#536050">
            ••••••••••
          </Text>
          <Text x={115} y={642} size={14}>
            □ Remember me
          </Text>
          <Text x={486} y={642} size={14} fill="#45694e">
            Forgot password?
          </Text>
          <Rect x={115} y={682} w={510} h={57} fill="#325441" />
          <Text x={335} y={717} size={16} fill="#fff" weight={550}>
            Sign in →
          </Text>
          <Text x={207} y={796} size={14}>
            New to Northstar?
          </Text>
          <Text x={350} y={796} size={14} fill="#45694e">
            Contact your account manager
          </Text>
          <Text x={115} y={910} size={12}>
            © 2026 Northstar. Sample design.
          </Text>
        </>
      ) : (
        <>
          <ProductHeader />
          {screen.kind === "orders" ? (
            <>
              <Text x={279} y={148} size={14}>
                ORDER MANAGEMENT
              </Text>
              <Text x={279} y={197} size={36} fill="#283b30" weight={600}>
                Your orders
              </Text>
              <Text x={279} y={232} size={16}>
                A little less chasing. A lot more clarity.
              </Text>
              <Rect x={1235} y={160} w={158} h={46} fill="#335541" />
              <Text x={1255} y={189} size={15} fill="#fff" weight={500}>
                ＋ New order
              </Text>
              {[
                ["Total orders", "24", "Across your workspace"],
                ["In progress", "08", "Being prepared for you"],
                ["On their way", "06", "Tracking available"],
              ].map((v, i) => (
                <g key={v[0]}>
                  <Rect
                    x={279 + i * 380}
                    y={271}
                    w={354}
                    h={131}
                    stroke="#e1e5dc"
                  />
                  <Text x={300 + i * 380} y={302} size={14}>
                    {v[0]}
                  </Text>
                  <Text
                    x={300 + i * 380}
                    y={348}
                    size={33}
                    fill="#33483a"
                    weight={550}
                  >
                    {v[1]}
                  </Text>
                  <Text x={300 + i * 380} y={379} size={12}>
                    {v[2]}
                  </Text>
                  <circle cx={591 + i * 380} cy={306} r={12} fill="#eef2e8" />
                </g>
              ))}
              <Rect x={279} y={435} w={1115} h={448} stroke="#e1e5dc" />
              <Rect
                x={299}
                y={455}
                w={327}
                h={42}
                fill="#fafbf8"
                stroke="#e0e5db"
              />
              <Text x={315} y={482} size={14}>
                ⌕ Search orders...
              </Text>
              <Rect x={643} y={455} w={161} h={42} stroke="#e0e5db" />
              <Text x={659} y={482} size={13}>
                All statuses ⌄
              </Text>
              <Text x={1264} y={482} size={13}>
                ⇩ Export
              </Text>
              <Rect x={280} y={518} w={1113} h={44} fill="#f6f8f3" r={0} />
              {["Order", "Customer", "Date", "Status", "Total"].map((h, i) => (
                <Text
                  key={h}
                  x={[307, 490, 775, 990, 1260][i]}
                  y={546}
                  size={12}
                  weight={600}
                >
                  {h}
                </Text>
              ))}
              {["1048", "1047", "1046", "1045", "1044"].map((n, i) => (
                <g key={n}>
                  <line
                    x1={280}
                    x2={1393}
                    y1={621 + i * 58}
                    y2={621 + i * 58}
                    stroke="#eef0e9"
                  />
                  <Text
                    x={307}
                    y={598 + i * 58}
                    size={14}
                    fill="#35493b"
                    weight={550}
                  >
                    NS-{n}
                  </Text>
                  <Text x={490} y={598 + i * 58} size={14} fill="#5c6b5b">
                    {
                      [
                        "Acme Studio",
                        "Greenhouse Supply",
                        "Acme Studio",
                        "Horizon Works",
                        "Acme Studio",
                      ][i]
                    }
                  </Text>
                  <Text x={775} y={598 + i * 58} size={13}>
                    Oct {14 - i}, 2026
                  </Text>
                  <Rect
                    x={982}
                    y={578 + i * 58}
                    w={110}
                    h={29}
                    fill={i === 1 ? "#e7eddb" : i === 3 ? "#eef0e8" : "#f6ebd9"}
                    r={15}
                  />
                  <Text
                    x={994}
                    y={597 + i * 58}
                    size={12}
                    fill={i === 1 ? "#587143" : "#8b7248"}
                  >
                    {
                      [
                        "In progress",
                        "Delivered",
                        "In progress",
                        "Draft",
                        "Shipped",
                      ][i]
                    }
                  </Text>
                  <Text x={1253} y={598 + i * 58} size={14} fill="#40513f">
                    {
                      [
                        "$2,450.00",
                        "$860.00",
                        "$4,120.00",
                        "$1,285.00",
                        "$3,640.00",
                      ][i]
                    }
                  </Text>
                </g>
              ))}
              <Text x={301} y={860} size={12}>
                Showing 1–5 of 24 orders
              </Text>
              <Text x={1240} y={860} size={12}>
                ‹ 1 2 3 ›
              </Text>
            </>
          ) : screen.kind === "create" ? (
            <>
              <Text x={279} y={135} size={14}>
                ‹ Orders
              </Text>
              <Text x={279} y={190} size={36} fill="#283b30" weight={600}>
                Create an order
              </Text>
              <Text x={279} y={224} size={16}>
                Good things start with the details.
              </Text>
              <Text x={1200} y={190} size={14}>
                Draft · Not saved
              </Text>
              <Rect x={279} y={267} w={740} h={586} stroke="#e1e5dc" />
              <Text x={304} y={309} size={19} weight={600} fill="#344a39">
                Order details
              </Text>
              {[
                ["Customer", "Acme Studio", 337],
                ["Purchase order number", "e.g. PO-2026-001", 435],
                ["Delivery address", "24 Market Street", 533],
              ].map(([label, placeholder, y]) => (
                <g key={label}>
                  <Text
                    x={305}
                    y={Number(y) + 22}
                    size={13}
                    weight={500}
                    fill="#52634d"
                  >
                    {label}
                  </Text>
                  <Rect
                    x={304}
                    y={Number(y) + 39}
                    w={687}
                    h={47}
                    stroke="#dce2d6"
                  />
                  <Text x={320} y={Number(y) + 68} size={14}>
                    {placeholder}
                  </Text>
                </g>
              ))}
              <Text x={305} y={685} size={14} weight={550} fill="#52634d">
                Line items
              </Text>
              <Rect x={304} y={704} w={687} h={65} fill="#f7f9f3" />
              <Text x={324} y={743} size={14}>
                Everyday notebook · Sand
              </Text>
              <Text x={690} y={743} size={14}>
                20 × $24.00
              </Text>
              <Text x={877} y={743} size={14}>
                $480.00
              </Text>
              <Text x={306} y={815} size={14} fill="#547450">
                ＋ Add another product
              </Text>
              <Rect x={1041} y={267} w={352} h={371} stroke="#e1e5dc" />
              <Text x={1065} y={310} size={19} fill="#344a39" weight={600}>
                Order summary
              </Text>
              <Text x={1065} y={367} size={14}>
                Subtotal
              </Text>
              <Text x={1286} y={367} size={14}>
                $480.00
              </Text>
              <Text x={1065} y={410} size={14}>
                Delivery
              </Text>
              <Text x={1302} y={410} size={14}>
                $20.00
              </Text>
              <Text x={1065} y={453} size={14}>
                Tax
              </Text>
              <Text x={1302} y={453} size={14}>
                $50.00
              </Text>
              <line x1={1065} x2={1368} y1={482} y2={482} stroke="#e2e7dc" />
              <Text x={1065} y={522} size={18} weight={600} fill="#344a39">
                Total
              </Text>
              <Text x={1275} y={522} size={22} fill="#344a39" weight={600}>
                $550.00
              </Text>
              <Rect x={1065} y={558} w={303} h={48} fill="#335541" />
              <Text x={1143} y={588} size={14} fill="#fff" weight={500}>
                Submit order →
              </Text>
              <Text x={1074} y={681} size={13}>
                Your order is saved only when submitted.
              </Text>
            </>
          ) : (
            <>
              <Text x={279} y={135} size={14}>
                ‹ Your orders
              </Text>
              <Text x={279} y={193} size={36} fill="#283b30" weight={600}>
                Order NS-1048
              </Text>
              <Rect x={571} y={167} w={119} h={32} fill="#f6ebd9" r={16} />
              <Text x={585} y={188} size={13} fill="#8b7248">
                In progress
              </Text>
              <Text x={279} y={232} size={16}>
                Placed on October 14, 2026 · Acme Studio
              </Text>
              <Rect x={279} y={274} w={1115} h={148} stroke="#e1e5dc" />
              {[
                "Order placed",
                "Confirmed",
                "Preparing",
                "Shipped",
                "Delivered",
              ].map((s, i) => (
                <g key={s}>
                  {i < 4 && (
                    <line
                      x1={381 + i * 218}
                      x2={552 + i * 218}
                      y1={321}
                      y2={321}
                      stroke={i < 2 ? "#54734d" : "#e0e5d9"}
                      strokeWidth={2}
                    />
                  )}
                  <circle
                    cx={365 + i * 218}
                    cy={321}
                    r={15}
                    fill={i < 3 ? "#4e6b48" : "#edf0e7"}
                  />
                  <Text
                    x={360 + i * 218}
                    y={326}
                    size={12}
                    fill={i < 3 ? "#fff" : "#9ba891"}
                  >
                    {i < 2 ? "✓" : i + 1}
                  </Text>
                  <Text x={325 + i * 218} y={369} size={13} fill="#62725b">
                    {s}
                  </Text>
                </g>
              ))}
              <Rect x={279} y={450} w={740} h={390} stroke="#e1e5dc" />
              <Text x={305} y={494} size={19} fill="#344a39" weight={600}>
                Items in this order
              </Text>
              {[
                "Everyday notebook · Sand",
                "Desk organiser · Walnut",
                "Weekly planner · Olive",
              ].map((s, i) => (
                <g key={s}>
                  <Rect
                    x={304}
                    y={527 + i * 90}
                    w={58}
                    h={58}
                    fill={["#e4d9c6", "#d0b69a", "#c9d1b9"][i]}
                  />
                  <Text
                    x={382}
                    y={552 + i * 90}
                    size={14}
                    fill="#43563d"
                    weight={500}
                  >
                    {s}
                  </Text>
                  <Text x={382} y={577 + i * 90} size={12}>
                    Qty {i === 0 ? "20" : "10"} · SKU NS-00{i + 1}
                  </Text>
                  <Text x={892} y={562 + i * 90} size={15}>
                    ${[480, 1200, 770][i]}.00
                  </Text>
                </g>
              ))}
              <Rect x={1041} y={450} w={352} h={390} stroke="#e1e5dc" />
              <Text x={1065} y={495} size={19} fill="#344a39" weight={600}>
                Delivery details
              </Text>
              <Text x={1065} y={544} size={15} weight={500} fill="#52634d">
                Jamie Davis
              </Text>
              <Text x={1065} y={577} size={14}>
                Acme Studio
              </Text>
              <Text x={1065} y={608} size={14}>
                24 Market Street
              </Text>
              <Text x={1065} y={639} size={14}>
                Brisbane, QLD 4000
              </Text>
              <Text x={1065} y={670} size={14}>
                Australia
              </Text>
              <line x1={1065} x2={1368} y1={707} y2={707} stroke="#e2e7dc" />
              <Text x={1065} y={746} size={13}>
                Estimated delivery
              </Text>
              <Text x={1065} y={778} size={16} fill="#52634d" weight={500}>
                October 19–21, 2026
              </Text>
            </>
          )}
        </>
      )}
      {!miniature && (
        <Text
          x={screen.kind === "login" ? 1300 : 1257}
          y={940}
          size={10}
          fill="#98a08f"
        >
          SYNTHETIC DESIGN
        </Text>
      )}
    </svg>
  );
}
