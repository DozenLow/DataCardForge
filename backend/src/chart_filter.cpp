#include "chart_filter.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <string>
#include <vector>

namespace dc {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;

ChartFilterResult failure(const std::string& reason) {
  ChartFilterResult result;
  result.errorCode = "filterFailed";
  result.errorParams = Json::object({{"reason", Json(reason)}});
  return result;
}

ChartFilterResult parameterFailure(const std::string& name) {
  ChartFilterResult result;
  result.errorCode = "badSignatureParams";
  result.errorParams = Json::object({{"name", Json(name)}});
  return result;
}

bool stringParam(const Json& params, const std::string& key, std::string* out) {
  const Json* value = params.find(key);
  if (!value || !value->isString()) return false;
  *out = value->asString();
  return true;
}

bool optionalNumber(const Json& params, const std::string& key, double fallback,
                    double* out) {
  const Json* value = params.find(key);
  if (!value) {
    *out = fallback;
    return true;
  }
  if (!value->isNumber() || !std::isfinite(value->asNumber())) return false;
  *out = value->asNumber();
  return true;
}

Column column(const std::string& name, const std::vector<double>& data, int ordinal) {
  Column out;
  out.posName = "Pos." + std::to_string(ordinal);
  out.annotation = name;
  out.data = data;
  return out;
}

struct Samples {
  std::vector<double> x;
  std::vector<double> y;
  double inferredSampleRate = NAN;
  bool invalidGrid = false;
  size_t dropped = 0;
};

Samples finiteSamples(const std::vector<double>* x, const std::vector<double>& y) {
  Samples samples;
  const size_t count = x ? std::min(x->size(), y.size()) : y.size();
  for (size_t index = 0; index < count; ++index) {
    const double xv = x ? (*x)[index] : static_cast<double>(index + 1);
    const double yv = y[index];
    if (!std::isfinite(xv) || !std::isfinite(yv)) {
      ++samples.dropped;
      continue;
    }
    samples.x.push_back(xv);
    samples.y.push_back(yv);
  }
  if (x && samples.x.size() >= 2) {
    std::vector<double> deltas;
    for (size_t index = 1; index < samples.x.size(); ++index) {
      const double delta = samples.x[index] - samples.x[index - 1];
      if (!(delta > 0.0)) {
        samples.invalidGrid = true;
        continue;
      }
      deltas.push_back(delta);
    }
    if (!samples.invalidGrid && !deltas.empty()) {
      std::sort(deltas.begin(), deltas.end());
      const double median = deltas[deltas.size() / 2];
      const double tolerance =
          std::max(1e-12, std::abs(median) * 1e-3);
      for (double delta : deltas) {
        if (std::abs(delta - median) > tolerance) {
          samples.invalidGrid = true;
          break;
        }
      }
      if (!samples.invalidGrid) samples.inferredSampleRate = 1.0 / median;
    }
  }
  return samples;
}

struct Section {
  double b0;
  double b1;
  double b2;
  double a1;
  double a2;
};

std::vector<Section> butterworthSections(int order, double cutoff, double sampleRate) {
  const double omega = 2.0 * kPi * cutoff / sampleRate;
  std::vector<Section> sections;
  const int pairCount = order / 2;
  for (int index = 0; index < pairCount; ++index) {
    const double qAngle = (2.0 * static_cast<double>(index) + 1.0) *
                          kPi / (2.0 * static_cast<double>(order));
    const double q = 1.0 / (2.0 * std::sin(qAngle));
    const double alpha = std::sin(omega) / (2.0 * q);
    const double cosine = std::cos(omega);
    const double a0 = 1.0 + alpha;
    sections.push_back(Section{
        (1.0 - cosine) / (2.0 * a0),
        (1.0 - cosine) / a0,
        (1.0 - cosine) / (2.0 * a0),
        -2.0 * cosine / a0,
        (1.0 - alpha) / a0,
    });
  }
  if (order % 2 == 1) {
    const double k = std::tan(kPi * cutoff / sampleRate);
    const double denominator = 1.0 + k;
    sections.push_back(Section{
        k / denominator,
        k / denominator,
        0.0,
        (k - 1.0) / denominator,
        0.0,
    });
  }
  return sections;
}

std::vector<double> applySection(const std::vector<double>& input,
                                 const Section& section, bool reverse) {
  std::vector<double> output(input.size(), 0.0);
  double x1 = 0.0;
  double x2 = 0.0;
  double y1 = 0.0;
  double y2 = 0.0;
  for (size_t step = 0; step < input.size(); ++step) {
    const size_t index = reverse ? input.size() - 1 - step : step;
    const double x0 = input[index];
    const double y0 = section.b0 * x0 + section.b1 * x1 + section.b2 * x2 -
                      section.a1 * y1 - section.a2 * y2;
    output[index] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return output;
}

std::vector<double> reflectPad(const std::vector<double>& input, size_t pad) {
  if (input.size() < 2) return input;
  std::vector<double> output(input.size() + 2 * pad, 0.0);
  for (size_t index = 0; index < pad; ++index) {
    const size_t source = 1 + index % (input.size() - 1);
    output[pad - 1 - index] = input[source];
    output[pad + input.size() + index] =
        input[input.size() - 2 - index % (input.size() - 1)];
  }
  std::copy(input.begin(), input.end(), output.begin() + static_cast<long>(pad));
  return output;
}

std::vector<double> zeroPhaseLowPass(const std::vector<double>& input, int order,
                                     double cutoff, double sampleRate) {
  const size_t pad = std::min(input.size() - 2, static_cast<size_t>(3 * order + 1));
  const std::vector<double> padded = reflectPad(input, pad);
  std::vector<double> output = padded;
  for (const Section& section : butterworthSections(order, cutoff, sampleRate)) {
    output = applySection(output, section, false);
    output = applySection(output, section, true);
  }
  return std::vector<double>(output.begin() + static_cast<long>(pad),
                              output.end() - static_cast<long>(pad));
}

void linearTrend(const Samples& samples, std::vector<double>* trend,
                 double* slope, double* intercept) {
  const size_t n = samples.x.size();
  double sumX = 0.0;
  double sumY = 0.0;
  for (size_t index = 0; index < n; ++index) {
    sumX += samples.x[index];
    sumY += samples.y[index];
  }
  const double meanX = sumX / static_cast<double>(n);
  const double meanY = sumY / static_cast<double>(n);
  double sxx = 0.0;
  double sxy = 0.0;
  for (size_t index = 0; index < n; ++index) {
    const double dx = samples.x[index] - meanX;
    sxx += dx * dx;
    sxy += dx * (samples.y[index] - meanY);
  }
  *slope = sxx > 0.0 ? sxy / sxx : 0.0;
  *intercept = meanY - *slope * meanX;
  trend->clear();
  for (double x : samples.x) trend->push_back(*slope * x + *intercept);
}

}  // namespace

ChartFilterResult evaluateChartFilter(const std::vector<double>* x,
                                      const std::vector<double>& y,
                                      const Json& params) {
  std::string mode;
  if (!stringParam(params, "mode", &mode)) return parameterFailure("mode");
  if (mode != "lowpass" && mode != "detrend") return parameterFailure("mode");
  const Samples samples = finiteSamples(x, y);
  if (mode == "lowpass" && samples.invalidGrid) return failure("nonUniformX");
  if (samples.x.size() < 2) return failure("tooFewPoints");
  if (x && mode == "lowpass" && !std::isfinite(samples.inferredSampleRate)) {
    return failure("nonUniformX");
  }

  double sampleRate = samples.inferredSampleRate;
  double cutoff = 0.0;
  double orderNumber = 4.0;
  if (mode == "lowpass") {
    if (!optionalNumber(params, "sampleRateHz", sampleRate, &sampleRate) ||
        !optionalNumber(params, "cutoffHz", cutoff, &cutoff) ||
        !optionalNumber(params, "order", 4.0, &orderNumber)) {
      return parameterFailure("lowpass parameters");
    }
    if (!(cutoff > 0.0) || !(sampleRate > 0.0) ||
        !(cutoff < sampleRate / 2.0)) {
      return failure("invalidFrequency");
    }
    if (orderNumber != std::floor(orderNumber) || orderNumber < 1.0 ||
        orderNumber > 10.0) {
      return parameterFailure("order");
    }
  }

  const int order = static_cast<int>(orderNumber);
  std::vector<double> filtered;
  std::vector<double> trend(samples.y.size(), 0.0);
  double slope = NAN;
  double intercept = NAN;
  if (mode == "lowpass") {
    if (samples.y.size() < 3 + static_cast<size_t>(3 * order)) return failure("tooFewPoints");
    filtered = zeroPhaseLowPass(samples.y, order, cutoff, sampleRate);
  } else {
    linearTrend(samples, &trend, &slope, &intercept);
    filtered.resize(samples.y.size());
    for (size_t index = 0; index < samples.y.size(); ++index)
      filtered[index] = samples.y[index] - trend[index];
  }

  ChartFilterResult result;
  const double finiteDropped = static_cast<double>(samples.dropped);
  const std::vector<std::string> names = {
      "n", "dropped", "sampleRateHz", "cutoffHz", "order", "trendSlope", "trendIntercept",
  };
  const std::vector<double> values = {
      static_cast<double>(samples.x.size()),
      finiteDropped,
      sampleRate,
      mode == "lowpass" ? cutoff : NAN,
      static_cast<double>(order),
      slope,
      intercept,
  };
  for (size_t index = 0; index < names.size(); ++index) {
    result.summary.push_back(column(names[index], {values[index]}, static_cast<int>(index + 1)));
  }
  const std::vector<std::pair<std::string, std::vector<double>>> series = {
      {"x", samples.x},
      {"raw", samples.y},
      {"filtered", filtered},
      {"trend", trend},
  };
  for (size_t index = 0; index < series.size(); ++index) {
    result.series.push_back(column(series[index].first, series[index].second,
                                   static_cast<int>(index + 1)));
  }
  return result;
}

}  // namespace dc
