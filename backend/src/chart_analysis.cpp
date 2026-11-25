#include "chart_analysis.h"

#include <Eigen/Dense>

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <numeric>
#include <string>
#include <vector>

namespace dc {
namespace {

struct Samples {
  std::vector<double> x;
  std::vector<double> y;
  std::vector<double> weights;
  size_t dropped = 0;
};

struct Fit {
  std::vector<double> params;
  double sse = 0.0;
  double weightedSse = 0.0;
  double r2 = NAN;
  double residualStandardError = NAN;
  Eigen::MatrixXd covariance;
  std::function<double(double, const std::vector<double>&)> predict;
  std::function<Eigen::VectorXd(double, const std::vector<double>&)> gradient;
  bool covarianceOk = false;
  bool converged = false;
};

ChartAnalysisResult failure(const std::string& code, const std::string& reason) {
  ChartAnalysisResult result;
  result.errorCode = code;
  result.errorParams = Json::object({{"reason", Json(reason)}});
  return result;
}

bool stringParam(const Json& params, const std::string& key,
                 const std::string& expectedDefault, std::string* out) {
  const Json* value = params.find(key);
  if (!value) {
    *out = expectedDefault;
    return true;
  }
  if (!value->isString()) return false;
  *out = value->asString();
  return true;
}

bool numberParam(const Json& params, const std::string& key, double fallback, double* out) {
  const Json* value = params.find(key);
  if (!value) {
    *out = fallback;
    return true;
  }
  if (!value->isNumber() || !std::isfinite(value->asNumber())) return false;
  *out = value->asNumber();
  return true;
}

bool boolParam(const Json& params, const std::string& key, bool fallback, bool* out) {
  const Json* value = params.find(key);
  if (!value) {
    *out = fallback;
    return true;
  }
  if (!value->isBool()) return false;
  *out = value->asBool();
  return true;
}

bool vectorParam(const Json& params, const std::string& key, size_t count,
                 std::vector<double>* out) {
  const Json* value = params.find(key);
  if (!value) return false;
  if (!value->isArray() || value->items().size() != count) return true;
  out->clear();
  for (const Json& item : value->items()) {
    if (!item.isNumber() || !std::isfinite(item.asNumber())) return true;
    out->push_back(item.asNumber());
  }
  return false;
}

Samples samplesFrom(const std::vector<double>* x, const std::vector<double>& y,
                    const std::string& weighting, std::string* error) {
  Samples samples;
  const size_t n = x ? std::min(x->size(), y.size()) : y.size();
  for (size_t index = 0; index < n; ++index) {
    const double xv = x ? (*x)[index] : static_cast<double>(index + 1);
    const double yv = y[index];
    if (!std::isfinite(xv) || !std::isfinite(yv)) {
      ++samples.dropped;
      continue;
    }
    double weight = 1.0;
    if (weighting == "inverseX") {
      if (!(xv > 0.0)) {
        *error = "nonPositiveX";
        return {};
      }
      weight = 1.0 / xv;
    } else if (weighting == "inverseX2") {
      if (!(xv > 0.0)) {
        *error = "nonPositiveX";
        return {};
      }
      weight = 1.0 / (xv * xv);
    }
    if (!std::isfinite(weight) || !(weight > 0.0)) {
      *error = "invalidWeight";
      return {};
    }
    samples.x.push_back(xv);
    samples.y.push_back(yv);
    samples.weights.push_back(weight);
  }
  return samples;
}

Eigen::VectorXd numericalGradient(
    const std::function<double(double, const std::vector<double>&)>& predict,
    double x, const std::vector<double>& params) {
  Eigen::VectorXd gradient(static_cast<Eigen::Index>(params.size()));
  for (size_t index = 0; index < params.size(); ++index) {
    std::vector<double> plus = params;
    std::vector<double> minus = params;
    const double step = 1e-5 * std::max(1.0, std::abs(params[index]));
    plus[index] += step;
    minus[index] -= step;
    const double high = predict(x, plus);
    const double low = predict(x, minus);
    gradient(static_cast<Eigen::Index>(index)) =
        std::isfinite(high) && std::isfinite(low) ? (high - low) / (2.0 * step) : NAN;
  }
  return gradient;
}

Fit fitLinear(const Samples& samples, bool throughOrigin) {
  Fit fit;
  const Eigen::Index n = static_cast<Eigen::Index>(samples.x.size());
  const Eigen::Index p = throughOrigin ? 1 : 2;
  Eigen::MatrixXd design(n, p);
  Eigen::VectorXd y(n);
  Eigen::VectorXd weights(n);
  for (Eigen::Index row = 0; row < n; ++row) {
    if (throughOrigin) {
      design(row, 0) = samples.x[static_cast<size_t>(row)];
    } else {
      design(row, 0) = samples.x[static_cast<size_t>(row)];
      design(row, 1) = 1.0;
    }
    y(row) = samples.y[static_cast<size_t>(row)];
    weights(row) = samples.weights[static_cast<size_t>(row)];
  }
  const Eigen::MatrixXd normal = design.transpose() * weights.asDiagonal() * design;
  Eigen::FullPivLU<Eigen::MatrixXd> rankCheck(normal);
  if (rankCheck.rank() < p) return fit;
  Eigen::LDLT<Eigen::MatrixXd> solver(normal);
  if (solver.info() != Eigen::Success || !solver.isPositive()) return fit;
  const Eigen::VectorXd solved =
      solver.solve(design.transpose() * weights.asDiagonal() * y);
  if (!solved.allFinite()) return fit;
  fit.params = std::vector<double>(solved.data(), solved.data() + solved.size());
  if (throughOrigin) fit.params.push_back(0.0);
  const double slope = fit.params[0];
  const double intercept = fit.params[1];
  fit.predict = [slope, intercept](double x, const std::vector<double>&) {
    return slope * x + intercept;
  };
  fit.gradient = [throughOrigin](double x, const std::vector<double>&) {
    Eigen::VectorXd gradient(throughOrigin ? 1 : 2);
    gradient(0) = x;
    if (!throughOrigin) gradient(1) = 1.0;
    return gradient;
  };
  fit.params.resize(throughOrigin ? 2 : 2);
  fit.covariance = solver.solve(
      Eigen::MatrixXd::Identity(p, p));
  fit.covarianceOk = fit.covariance.allFinite();
  fit.converged = true;
  return fit;
}

double modelValue(const std::string& model, double x, const std::vector<double>& p) {
  if (model == "linear") return p[0] * x + p[1];
  if (model == "exponential") return p[0] * std::exp(p[1] * x);
  if (model == "power") {
    if (!(x > 0.0)) return NAN;
    return p[0] * std::pow(x, p[1]);
  }
  if (model == "4pl") {
    if (!(x > 0.0) || !(p[2] > 0.0)) return NAN;
    const double ratioPower = std::pow(x / p[2], -p[3]);
    return p[0] + (p[1] - p[0]) / (1.0 + ratioPower);
  }
  return NAN;
}

std::vector<double> defaultInitial(const Samples& samples, const std::string& model) {
  const auto [minYIt, maxYIt] = std::minmax_element(samples.y.begin(), samples.y.end());
  const double minY = *minYIt;
  const double maxY = *maxYIt;
  if (model == "exponential") {
    double a = minY;
    double b = 0.0;
    if (minY > 0.0) {
      std::vector<double> positiveX;
      std::vector<double> logY;
      for (size_t index = 0; index < samples.y.size(); ++index) {
        if (samples.y[index] > 0.0) {
          positiveX.push_back(samples.x[index]);
          logY.push_back(std::log(samples.y[index]));
        }
      }
      const double mx = std::accumulate(positiveX.begin(), positiveX.end(), 0.0) /
                         std::max<size_t>(1, positiveX.size());
      const double my = std::accumulate(logY.begin(), logY.end(), 0.0) /
                         std::max<size_t>(1, logY.size());
      double sxx = 0.0;
      double sxy = 0.0;
      for (size_t index = 0; index < positiveX.size(); ++index) {
        sxx += (positiveX[index] - mx) * (positiveX[index] - mx);
        sxy += (positiveX[index] - mx) * (logY[index] - my);
      }
      b = sxx > 0.0 ? sxy / sxx : 0.0;
      a = std::exp(my - b * mx);
    }
    return {a, b};
  }
  if (model == "power") {
    double a = 1.0;
    double b = 1.0;
    std::vector<double> lx;
    std::vector<double> ly;
    for (size_t index = 0; index < samples.x.size(); ++index) {
      if (samples.x[index] > 0.0 && samples.y[index] > 0.0) {
        lx.push_back(std::log(samples.x[index]));
        ly.push_back(std::log(samples.y[index]));
      }
    }
    if (lx.size() >= 2) {
      const double mx = std::accumulate(lx.begin(), lx.end(), 0.0) /
                         static_cast<double>(lx.size());
      const double my = std::accumulate(ly.begin(), ly.end(), 0.0) /
                         static_cast<double>(ly.size());
      double sxx = 0.0;
      double sxy = 0.0;
      for (size_t index = 0; index < lx.size(); ++index) {
        sxx += (lx[index] - mx) * (lx[index] - mx);
        sxy += (lx[index] - mx) * (ly[index] - my);
      }
      b = sxx > 0.0 ? sxy / sxx : 1.0;
      a = std::exp(my - b * mx);
    }
    return {a, b};
  }
  std::vector<double> positiveX;
  for (double x : samples.x) if (x > 0.0) positiveX.push_back(x);
  std::sort(positiveX.begin(), positiveX.end());
  const double midpoint = positiveX.empty()
                              ? 1.0
                              : positiveX[positiveX.size() / 2];
  return {minY, maxY, midpoint, 1.0};
}

std::pair<std::vector<double>, std::vector<double>> defaultBounds(
    const Samples& samples, const std::vector<double>& initial, const std::string& model) {
  std::vector<double> lower(initial.size(), -std::numeric_limits<double>::max());
  std::vector<double> upper(initial.size(), std::numeric_limits<double>::max());
  if (model == "exponential" || model == "power") {
    lower = {-1e12, -50.0};
    upper = {1e12, 50.0};
    return {lower, upper};
  }
  const double minY = *std::min_element(samples.y.begin(), samples.y.end());
  const double maxY = *std::max_element(samples.y.begin(), samples.y.end());
  const double minX = *std::min_element(samples.x.begin(), samples.x.end());
  const double maxX = *std::max_element(samples.x.begin(), samples.x.end());
  const double range = std::max(1.0, maxY - minY);
  lower = {minY - 2.0 * range, minY - 2.0 * range,
           std::max(1e-12, minX * 0.01), -20.0};
  upper = {maxY + 2.0 * range, maxY + 2.0 * range,
           std::max(1.0, maxX * 100.0), 20.0};
  return {lower, upper};
}

bool validBounds(const std::vector<double>& initial,
                 const std::vector<double>& lower,
                 const std::vector<double>& upper, const std::string& model) {
  if (initial.size() != lower.size() || initial.size() != upper.size()) return false;
  for (size_t index = 0; index < initial.size(); ++index) {
    if (!std::isfinite(initial[index]) || !std::isfinite(lower[index]) ||
        !std::isfinite(upper[index]) || lower[index] > upper[index] ||
        initial[index] < lower[index] || initial[index] > upper[index]) {
      return false;
    }
  }
  if (model == "power" && !(upper[0] > 0.0)) return false;
  if (model == "4pl" && !(lower[2] > 0.0)) return false;
  return true;
}

double weightedCost(const Samples& samples, const std::string& model,
                    const std::vector<double>& params) {
  double cost = 0.0;
  for (size_t index = 0; index < samples.x.size(); ++index) {
    const double predicted = modelValue(model, samples.x[index], params);
    if (!std::isfinite(predicted)) return std::numeric_limits<double>::infinity();
    const double residual = predicted - samples.y[index];
    cost += samples.weights[index] * residual * residual;
  }
  return cost;
}

Fit optimizeNonlinear(const Samples& samples, const std::string& model,
                      std::vector<double> initial,
                      std::vector<double> lower,
                      std::vector<double> upper) {
  Fit fit;
  fit.params = std::move(initial);
  fit.predict = [model](double x, const std::vector<double>& p) {
    return modelValue(model, x, p);
  };
  fit.gradient = [model](double x, const std::vector<double>& p) {
    return numericalGradient(
        [model](double value, const std::vector<double>& params) {
          return modelValue(model, value, params);
        },
        x, p);
  };
  double lambda = 1e-3;
  double cost = weightedCost(samples, model, fit.params);
  for (int iteration = 0; iteration < 300; ++iteration) {
    const Eigen::Index p = static_cast<Eigen::Index>(fit.params.size());
    Eigen::MatrixXd normal = Eigen::MatrixXd::Zero(p, p);
    Eigen::VectorXd gradient = Eigen::VectorXd::Zero(p);
    bool derivativesOk = true;
    for (size_t row = 0; row < samples.x.size(); ++row) {
      const double predicted = modelValue(model, samples.x[row], fit.params);
      const Eigen::VectorXd jacobian = numericalGradient(
          [model](double x, const std::vector<double>& params) {
            return modelValue(model, x, params);
          },
          samples.x[row], fit.params);
      if (!jacobian.allFinite() || !std::isfinite(predicted)) {
        derivativesOk = false;
        break;
      }
      const double residual = predicted - samples.y[row];
      normal += samples.weights[row] * jacobian * jacobian.transpose();
      gradient += samples.weights[row] * jacobian * residual;
    }
    if (!derivativesOk) break;
    Eigen::MatrixXd damped = normal;
    for (Eigen::Index index = 0; index < p; ++index)
      damped(index, index) += lambda * std::max(1.0, normal(index, index));
    Eigen::LDLT<Eigen::MatrixXd> solver(damped);
    if (solver.info() != Eigen::Success) {
      lambda *= 10.0;
      continue;
    }
    const Eigen::VectorXd step = solver.solve(-gradient);
    if (!step.allFinite()) break;
    if (step.lpNorm<Eigen::Infinity>() < 1e-10) {
      fit.converged = true;
      break;
    }
    std::vector<double> candidate = fit.params;
    for (Eigen::Index index = 0; index < p; ++index) {
      candidate[static_cast<size_t>(index)] =
          std::clamp(candidate[static_cast<size_t>(index)] + step(index),
                     lower[static_cast<size_t>(index)],
                     upper[static_cast<size_t>(index)]);
    }
    const double next = weightedCost(samples, model, candidate);
    if (next < cost) {
      const double improvement = cost - next;
      fit.params = std::move(candidate);
      cost = next;
      lambda = std::max(1e-12, lambda / 3.0);
      if (improvement < 1e-12 * std::max(1.0, cost)) {
        fit.converged = true;
        break;
      }
    } else {
      lambda *= 10.0;
      if (lambda > 1e16) break;
    }
  }
  if (!fit.converged && std::isfinite(cost) && cost < 1e-20) fit.converged = true;
  return fit;
}

double tCritical95(size_t degrees) {
  static const double table[] = {
      12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
      2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
      2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
  };
  if (degrees == 0) return 12.706;
  if (degrees <= 30) return table[degrees - 1];
  return 1.96;
}

double normalQuantile(double p) {
  static const double a[] = {
      -39.6968302866538, 220.946098424521, -275.928510446969,
      138.357751867269, -30.6647980661472, 2.50662827745924,
  };
  static const double b[] = {
      -54.4760987982241, 161.585836042302, -155.698979859887,
      66.8013118877197, -13.2806815528857,
  };
  static const double c[] = {
      -0.00778489400243029, -0.322396458041136, -2.40075827716184,
      -2.54973253934373, 4.37466414146497, 2.93816398269878,
  };
  static const double d[] = {
      0.00778469570904146, 0.32246712907004, 2.445134137143,
      3.75440866190742,
  };
  const double plow = 0.02425;
  const double phigh = 1.0 - plow;
  double result;
  if (p < plow) {
    const double q = std::sqrt(-2.0 * std::log(p));
    result = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
             ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0);
  } else if (p <= phigh) {
    const double q = p - 0.5;
    const double r = q * q;
    result = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
             (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0);
  } else {
    const double q = std::sqrt(-2.0 * std::log(1.0 - p));
    result = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
             ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0);
  }
  return result;
}

Column column(const std::string& name, const std::vector<double>& data, int position) {
  Column out;
  out.posName = "Pos." + std::to_string(position);
  out.annotation = name;
  out.data = data;
  return out;
}

}  // namespace

ChartAnalysisResult evaluateChartAnalysis(const std::vector<double>* x,
                                           const std::vector<double>& y,
                                           const Json& params) {
  std::string model;
  std::string weighting;
  bool throughOrigin;
  double confidence = 0.95;
  if (!stringParam(params, "model", "linear", &model) ||
      !stringParam(params, "weighting", "none", &weighting) ||
      !boolParam(params, "throughOrigin", false, &throughOrigin) ||
      !numberParam(params, "confidence", 0.95, &confidence)) {
    return failure("badSignatureParams", "parameters");
  }
  if (model != "linear" && model != "exponential" && model != "power" && model != "4pl") {
    return failure("badSignatureParams", "model");
  }
  if (weighting != "none" && weighting != "inverseX" && weighting != "inverseX2") {
    return failure("badSignatureParams", "weighting");
  }
  if (!(confidence > 0.5 && confidence < 1.0)) {
    return failure("badSignatureParams", "confidence");
  }
  if (model != "linear" && throughOrigin) {
    return failure("badSignatureParams", "throughOrigin");
  }
  if (std::abs(confidence - 0.95) > 1e-9) {
    return failure("badSignatureParams", "confidence");
  }

  std::string weightError;
  const Samples samples = samplesFrom(x, y, weighting, &weightError);
  if (!weightError.empty()) return failure("fitFailed", weightError);
  const size_t expectedParams = model == "4pl" ? 4 : 2;
  if (samples.x.size() <= expectedParams) return failure("fitFailed", "tooFewPoints");
  if (model == "power" &&
      std::any_of(samples.x.begin(), samples.x.end(), [](double value) { return !(value > 0.0); })) {
    return failure("fitFailed", "nonPositiveX");
  }
  if (model == "4pl" &&
      std::any_of(samples.x.begin(), samples.x.end(), [](double value) { return !(value > 0.0); })) {
    return failure("fitFailed", "nonPositiveX");
  }

  Fit fit;
  if (model == "linear") {
    fit = fitLinear(samples, throughOrigin);
  } else {
    std::vector<double> initial = defaultInitial(samples, model);
    std::vector<double> lower;
    std::vector<double> upper;
    if (params.find("initial")) {
      if (vectorParam(params, "initial", expectedParams, &initial))
        return failure("badSignatureParams", "initial");
    }
    auto defaults = defaultBounds(samples, initial, model);
    lower = std::move(defaults.first);
    upper = std::move(defaults.second);
    if (params.find("lower")) {
      if (vectorParam(params, "lower", expectedParams, &lower))
        return failure("badSignatureParams", "lower");
    }
    if (params.find("upper")) {
      if (vectorParam(params, "upper", expectedParams, &upper))
        return failure("badSignatureParams", "upper");
    }
    if (!validBounds(initial, lower, upper, model)) {
      return failure("badSignatureParams", "bounds");
    }
    fit = optimizeNonlinear(samples, model, std::move(initial),
                            std::move(lower), std::move(upper));
  }
  if (!fit.converged || fit.params.size() < 2) return failure("fitFailed", "notConverged");

  const size_t parameterCount = model == "linear" && throughOrigin
                                    ? 1
                                    : model == "4pl"
                                        ? 4
                                        : 2;
  fit.weightedSse = 0.0;
  fit.sse = 0.0;
  double meanY = std::accumulate(samples.y.begin(), samples.y.end(), 0.0) /
                 static_cast<double>(samples.y.size());
  double totalSquares = 0.0;
  std::vector<double> residuals;
  for (size_t index = 0; index < samples.x.size(); ++index) {
    const double predicted = fit.predict(samples.x[index], fit.params);
    const double residual = samples.y[index] - predicted;
    fit.sse += residual * residual;
    fit.weightedSse += samples.weights[index] * residual * residual;
    totalSquares += (samples.y[index] - meanY) * (samples.y[index] - meanY);
    residuals.push_back(residual);
  }
  fit.r2 = totalSquares > 0.0 ? 1.0 - fit.sse / totalSquares : (fit.sse == 0.0 ? 1.0 : 0.0);
  const bool enough = samples.x.size() > parameterCount;
  if (enough) {
    fit.residualStandardError =
        std::sqrt(std::max(0.0, fit.weightedSse /
                                      static_cast<double>(samples.x.size() - parameterCount)));
    if (model != "linear") {
      Eigen::MatrixXd normal =
          Eigen::MatrixXd::Zero(static_cast<Eigen::Index>(parameterCount),
                                static_cast<Eigen::Index>(parameterCount));
      bool derivativesOk = true;
      for (size_t index = 0; index < samples.x.size(); ++index) {
        const Eigen::VectorXd jacobian = fit.gradient(samples.x[index], fit.params);
        if (!jacobian.allFinite()) {
          derivativesOk = false;
          break;
        }
        normal += samples.weights[index] * jacobian * jacobian.transpose();
      }
      Eigen::LDLT<Eigen::MatrixXd> solver(normal);
      if (derivativesOk && solver.info() == Eigen::Success && solver.isPositive()) {
        fit.covariance = solver.solve(
            Eigen::MatrixXd::Identity(normal.rows(), normal.cols())) *
                         fit.residualStandardError * fit.residualStandardError;
        fit.covarianceOk = fit.covariance.allFinite();
      }
    } else if (fit.covarianceOk) {
      fit.covariance *= fit.residualStandardError * fit.residualStandardError;
    }
  }

  const double slope = model == "linear" ? fit.params[0] : NAN;
  const double intercept = model == "linear" ? fit.params[1] : NAN;
  const double lod =
      model == "linear" && slope != 0.0 && std::isfinite(fit.residualStandardError)
          ? 3.3 * fit.residualStandardError / std::abs(slope)
          : NAN;
  const double loq =
      model == "linear" && slope != 0.0 && std::isfinite(fit.residualStandardError)
          ? 10.0 * fit.residualStandardError / std::abs(slope)
          : NAN;
  const std::vector<double> standardized = [&] {
    std::vector<double> values;
    for (double residual : residuals) {
      values.push_back(std::isfinite(fit.residualStandardError) &&
                               fit.residualStandardError > 0.0
                           ? residual / fit.residualStandardError
                           : 0.0);
    }
    return values;
  }();
  std::vector<double> sortedResiduals = residuals;
  std::sort(sortedResiduals.begin(), sortedResiduals.end());

  std::vector<double> fitted;
  std::vector<double> confidenceLow;
  std::vector<double> confidenceHigh;
  std::vector<double> predictionLow;
  std::vector<double> predictionHigh;
  std::vector<double> qqTheoretical;
  std::vector<double> qqResidual;
  const double t = tCritical95(enough ? samples.x.size() - parameterCount : 0);
  for (size_t index = 0; index < samples.x.size(); ++index) {
    const double prediction = fit.predict(samples.x[index], fit.params);
    fitted.push_back(prediction);
    double meanVariance = NAN;
    if (fit.covarianceOk) {
      const Eigen::VectorXd gradient = fit.gradient(samples.x[index], fit.params);
      if (gradient.allFinite()) meanVariance = gradient.dot(fit.covariance * gradient);
    }
    const double ciDelta =
        std::isfinite(meanVariance) ? t * std::sqrt(std::max(0.0, meanVariance)) : NAN;
    confidenceLow.push_back(prediction - ciDelta);
    confidenceHigh.push_back(prediction + ciDelta);
    const double piVariance =
        meanVariance + fit.residualStandardError * fit.residualStandardError /
                           samples.weights[index];
    const double piDelta =
        std::isfinite(piVariance) ? t * std::sqrt(std::max(0.0, piVariance)) : NAN;
    predictionLow.push_back(prediction - piDelta);
    predictionHigh.push_back(prediction + piDelta);
  }
  const double count = static_cast<double>(samples.x.size());
  for (size_t index = 0; index < samples.x.size(); ++index) {
    const double probability =
        (static_cast<double>(index) + 1.0 - 0.375) / (count + 0.25);
    qqTheoretical.push_back(normalQuantile(probability));
    qqResidual.push_back(sortedResiduals[index]);
  }

  ChartAnalysisResult result;
  const std::vector<std::string> summaryNames = {
      "n", "dropped", "parameterCount", "r2", "sse", "residualStandardError",
      "slope", "intercept", "a", "b", "c", "d", "lod", "loq",
  };
  const std::vector<double> summaryValues = {
      count,
      static_cast<double>(samples.dropped),
      static_cast<double>(parameterCount),
      fit.r2,
      fit.sse,
      fit.residualStandardError,
      slope,
      intercept,
      fit.params[0],
      fit.params[1],
      fit.params.size() > 2 ? fit.params[2] : NAN,
      fit.params.size() > 3 ? fit.params[3] : NAN,
      lod,
      loq,
  };
  for (size_t index = 0; index < summaryNames.size(); ++index) {
    result.summary.push_back(
        column(summaryNames[index], {summaryValues[index]}, static_cast<int>(index + 1)));
  }

  const std::vector<std::pair<std::string, std::vector<double>>> seriesColumns = {
      {"x", samples.x},
      {"y", samples.y},
      {"fitted", fitted},
      {"residual", residuals},
      {"standardizedResidual", standardized},
      {"confidenceLower", confidenceLow},
      {"confidenceUpper", confidenceHigh},
      {"predictionLower", predictionLow},
      {"predictionUpper", predictionHigh},
      {"qqTheoretical", qqTheoretical},
      {"qqResidual", qqResidual},
  };
  for (size_t index = 0; index < seriesColumns.size(); ++index) {
    result.series.push_back(column(seriesColumns[index].first,
                                   seriesColumns[index].second,
                                   static_cast<int>(index + 1)));
  }
  return result;
}

}  // namespace dc
